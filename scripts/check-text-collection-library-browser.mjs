// Real DOM/client/account-file service; intercepted transport and synthetic login, never production ST.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createTextCollection} from '../qianmu-text-collection.js';
import {createTextCollectionSyncService} from '../qianmu-text-collection-sync-service.js';
import {textCollectionSyncErrorPayload} from '../qianmu-text-collection-sync-contract.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const temporary=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(temporary,'qianmu-collection-library-')),folder=path.join(root,'alice');await fs.mkdir(folder);
const expectedAccount='st-user:'+createHash('sha256').update('alice').digest('hex'),request={user:{profile:{handle:'alice'},directories:{root:folder}}};
const service=createTextCollectionSyncService({dataRoot:root});
const make=id=>({version:1,expectedAccount,mutationId:randomUUID(),operation:'create',id,baseRevision:0,record:createTextCollection({id,mode:'full',createdAt:Date.UTC(2026,8,19)+Number(id.split('-')[1]||0),
  source:{account:expectedAccount,chatId:'deleted-chat',messageId:0,replyId:'old-reply',charName:'当时角色',userName:'<旧用户>',text:`收藏原文 ${id}\r\n不依赖聊天`}})});
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext(),page=await context.newPage();
const allowed=new Set(['qianmu-notes-sync-contract.js','qianmu-text-collection.js','qianmu-json-input.js','qianmu-storage-backup-view.js',...['cleanup-batch','bulk-contract','storage','restore-view','restore-batch','export','backup','floor','library','session','client','sync-contract'].map(name=>`qianmu-text-collection-${name}.js`)]);
const checks=[],errors=[],writes=[];let reads=0,external=0,loseAck=false,failListOnce=false,rejectDraftCopy=false;
for(const file of ['qianmu-account-local-store.js','qianmu-text-collection-outbox-store.js','qianmu-text-collection-outbox-runtime.js','qianmu-text-collection-outbox-view.js','qianmu-text-collection-outbox-backup.js'])allowed.add(file);
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'){
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="fixture"></main>'});
    if(url.pathname==='/qianmu-text-collection.css')return route.fulfill({contentType:'text/css',body:await fs.readFile(new URL('../qianmu-text-collection.css',import.meta.url),'utf8')});
    const file=url.pathname.slice(1);if(allowed.has(file))return route.fulfill({contentType:'text/javascript',body:await fs.readFile(new URL('../'+file,import.meta.url),'utf8')});
    const action=url.pathname.split('/').at(-1);
    if(url.pathname.startsWith('/api/plugins/qianmu-tts/text-collections/')&&['list','get','snapshot','restore-info','inventory','write','write-batch','batch-info','cleanup-plan'].includes(action)&&route.request().method()==='POST'){
      const input=route.request().postDataJSON();assert.equal(route.request().headers()['x-csrf-token'],'fixture-only');
      if(action==='list'&&failListOnce){failListOnce=false;return route.abort('failed');}
      if(action==='get')reads++;if(['write','write-batch'].includes(action))writes.push(input);
      if(action==='write'&&rejectDraftCopy&&input.operation==='restore'&&Object.hasOwn(input,'text'))return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({ok:false,version:1,code:'text_collection_sync_contract',message:'旧版本不支持此格式',writeState:'not_started'})});
      try{const result=await service[action](request,input);if(['write','write-batch'].includes(action)&&loseAck){loseAck=false;return route.abort('failed');}return route.fulfill({contentType:'application/json',body:JSON.stringify(result)});}
      catch(cause){const error=textCollectionSyncErrorPayload(cause);return route.fulfill({status:error.status,contentType:'application/json',body:JSON.stringify(error.body)});}
    }
  }
  external++;return route.abort();
});
const button=name=>page.locator(`[data-collection-manage="${name}"]`),status=()=>page.locator('[data-collection-status]').textContent();
const ready=()=>page.waitForFunction(()=>document.querySelector('dialog')?.getAttribute('aria-busy')==='false');
try{
  for(let i=0;i<51;i++)await service.write(request,make(`collection-${i}`));
  await page.goto('https://qianmu.test/');await page.addStyleTag({content:await fs.readFile(new URL('../style.css',import.meta.url),'utf8')});await page.addStyleTag({content:await fs.readFile(new URL('../qianmu-text-collection.css',import.meta.url),'utf8')});
  await page.evaluate(async()=>{
    const {createTextCollectionFloorTools}=await import('./qianmu-text-collection-floor.js');
    window.fixture={namespace:'st-user:alice',current:true,consent:true,copied:null,escaped:0};
    fixture.floorTools=createTextCollectionFloorTools({getContext:()=>({chat:[]}),getChatKey:()=>{throw Error('library must not need a chat');},names:()=>{throw Error('library must not borrow current names');},resolveNamespace:async()=>fixture.namespace,isCurrent:()=>fixture.current,headers:()=>({'X-CSRF-Token':'fixture-only'})});
    fixture.open=async()=>{fixture.namespace='st-user:alice';fixture.current=true;fixture.host=document.createElement('section');document.getElementById('fixture').append(fixture.host);
      fixture.host.addEventListener('keydown',event=>{if(event.key==='Escape'){fixture.escaped++;fixture.host.remove();}});
      fixture.ui=await fixture.floorTools.openLibrary(fixture.host,async(...args)=>{fixture.lastConfirm=args;return fixture.holdConfirm?new Promise(resolve=>{fixture.acceptConfirm=resolve;}):fixture.consent;},async text=>{fixture.copied=text;});};
    await fixture.open();
  });await ready();
  assert.equal(await page.locator('[data-collection-id]').count(),50);assert.equal(reads,0);assert.match(await status(),/51.*第 1 页/);
  await page.evaluate(()=>fixture.floorTools.openLibrary(fixture.host,async()=>true));assert.equal(await page.locator('dialog').count(),1);
  await button('next').click();await ready();assert.equal(await page.locator('[data-collection-id]').count(),1);assert.equal(await button('next').isDisabled(),true);
  await button('prev').click();await ready();assert.equal(await page.locator('[data-collection-id]').count(),50);
  checks.push('50-item pages use summary-only reads with correct previous/next controls');
  const search=page.locator('input[aria-label="搜索收藏"]');await search.fill('COLLECTION-4');await search.press('Enter');await ready();
  assert.equal(await page.locator('[data-collection-id]').count(),11);assert.equal(reads,0);assert.equal(await button('next').isDisabled(),true);
  await search.fill('不存在');await button('search').click();await ready();assert.equal(await page.locator('[data-collection-id]').count(),0);
  await search.fill('旧用户');await button('search').click();await ready();assert.equal(await page.locator('[data-collection-id]').count(),50);await button('next').click();await ready();assert.equal(await page.locator('[data-collection-id]').count(),1);
  await button('clear-search').click();await ready();assert.equal(await page.locator('[data-collection-id]').count(),50);assert.equal(await search.inputValue(),'');
  checks.push('explicit library-wide search finds prose or captured names without eager body reads and resets pagination on query changes');
  await page.locator('[data-collection-id="collection-50"]').click();await ready();assert.equal(reads,1);
  assert.match(await page.locator('[data-collection-title]').textContent(),/当时角色 & <旧用户>.*2026-09-19/);
  await button('copy').click();await ready();assert.equal(await page.evaluate(()=>fixture.copied),'收藏原文 collection-50\n不依赖聊天');
  await button('edit').click();await ready();await page.locator('[data-collection-editor]').fill('我编辑的收藏');
  loseAck=true;await button('save').click();await ready();assert.equal(await page.locator('[data-collection-editor]').inputValue(),'我编辑的收藏');
  assert.match(await status(),/未确认|中断|损坏/);const first=structuredClone(writes.at(-1));await button('save').click();await ready();
  assert.deepEqual(writes.at(-1),first);assert.match(await status(),/修改已保存/);
  checks.push('detail loads only its original, copy stays text, and lost acknowledgement retry confirms the identical disk write');
  await button('edit').click();await ready();await page.locator('[data-collection-editor]').fill('不要丢失的本机修改');
  await service.write(request,{version:1,expectedAccount,mutationId:randomUUID(),operation:'edit',id:'collection-50',baseRevision:2,text:'另一端修改'});
  await button('save').click();await ready();assert.match(await status(),/其他设备变更/);assert.equal(await page.locator('[data-collection-editor]').inputValue(),'不要丢失的本机修改');
  assert.match(await status(),/本机待存/);
  await page.evaluate(()=>{fixture.consent=false;});await button('reload').click();await ready();assert.equal(await page.locator('[data-collection-editor]').inputValue(),'不要丢失的本机修改');
  await button('close').click();assert.equal(await page.locator('dialog').count(),1);
  await page.locator('[data-collection-editor]').focus();await page.keyboard.press('Escape');assert.equal(await page.locator('dialog').count(),1);assert.equal(await page.evaluate(()=>fixture.escaped),0);
  await page.evaluate(()=>{fixture.consent=true;});await button('reload').click();await ready();assert.equal(await page.locator('[data-collection-editor]').inputValue(),'另一端修改');
  checks.push('revision conflicts preserve the local draft and explicit discard confirmation gates reload or close');
  const pending=await page.evaluate(async account=>{const {createTextCollectionOutboxStore}=await import('./qianmu-text-collection-outbox-store.js');const store=createTextCollectionOutboxStore();try{return (await store.read(account)).entries;}finally{store.close();}},expectedAccount);
  assert.equal(pending.length,1);assert.equal(pending[0].state,'conflict');assert.equal(pending[0].request.text,'不要丢失的本机修改');assert.equal(pending[0].base.text,'我编辑的收藏');
  checks.push('editor conflict preserves both local draft and captured base in real IndexedDB even after explicitly reloading the server original');
  await button('delete').click();await ready();assert.match(await status(),/已删除收藏/);
  assert.equal((await service.get(request,{version:1,expectedAccount,id:'collection-50'})).record,null);
  assert.equal(await page.locator('[data-collection-id]').count(),50);
  const disk=await fs.readFile(path.join(folder,'.qianmu-text-collection-v1.json'),'utf8');assert.doesNotMatch(disk,/另一端修改|我编辑的收藏/);
  checks.push('deletion clears only the chosen original and its old text, leaving the remaining library intact');
  for(const width of [320,393,1280]){
    await page.setViewportSize({width,height:850});const bounds=await page.locator('dialog').evaluate(node=>({width:node.getBoundingClientRect().width,scroll:node.scrollWidth,client:node.clientWidth}));
    assert.ok(bounds.width<=width&&bounds.scroll<=bounds.client+1,JSON.stringify(bounds));
  }
  checks.push('320/393/1280px library lists stay inside the viewport with bounded scrolling');
  await service.write(request,make('collection-99'));await button('refresh').click();await ready();
  await service.write(request,make('collection-98'));await button('next').click();await ready();assert.match(await status(),/变更|刷新/);
  await button('refresh').click();await ready();assert.match(await status(),/52/);
  checks.push('concurrent library changes reject stale cursors and recover only by explicit refresh');
  await page.locator('[data-collection-id="collection-99"]').click();await ready();failListOnce=true;
  await button('delete').click();await ready();assert.match(await status(),/收藏已删除，列表暂未刷新/);assert.equal(await button('refresh').isVisible(),true);
  await button('refresh').click();await ready();assert.match(await status(),/51/);
  checks.push('confirmed deletion stays truthful when the following list read fails and retains an actionable refresh path');
  await page.evaluate(()=>{fixture.namespace='st-user:bob';});await button('refresh').click();await page.waitForFunction(()=>!document.querySelector('dialog'));
  await page.evaluate(()=>fixture.open());await ready();await page.evaluate(()=>fixture.host.remove());await page.waitForFunction(()=>!document.querySelector('dialog'));
  checks.push('account change and parent disposal close the old library without adopting another account');
  await page.evaluate(()=>fixture.open());await ready();
  await page.evaluate(()=>{const chat=document.createElement('div');document.body.append(chat);fixture.floorTools.refresh(chat);});assert.equal(await page.locator('dialog').count(),1);
  await page.evaluate(()=>fixture.floorTools.dispose());await page.waitForFunction(()=>!document.querySelector('dialog'));
  assert.equal(await page.locator('[data-qm-text-collection-portal]').count(),0);
  checks.push('floor-tools launcher works with no chat, deduplicates opens, isolates Escape, survives chat-root replacement and cleans up on owner disposal');
  await page.evaluate(async()=>{
    const {renderStorageBackupSection}=await import('./qianmu-storage-backup-view.js');const host=document.createElement('section');host.innerHTML=renderStorageBackupSection();document.body.append(host);
    fixture.exportButton=host.querySelector('[data-storage-export="collections"]');fixture.downloads=[];fixture.exportAsks=0;fixture.releases=0;
    fixture.runExport=()=>fixture.floorTools.exportBackup(fixture.exportButton,async()=>{fixture.exportAsks++;return new Promise(resolve=>{fixture.acceptExport=resolve;});},async(blob,name)=>fixture.downloads.push({payload:JSON.parse(await blob.text()),name}),()=>{const check=()=>{if(!host.isConnected)throw Error('closed');};check.release=()=>fixture.releases++;return check;});
    fixture.exportPending=fixture.runExport();
  });await page.waitForFunction(()=>fixture.exportAsks===1);
  assert.equal(await page.locator('[data-storage-export="collections"]').isDisabled(),true);
  await page.evaluate(()=>fixture.runExport());assert.equal(await page.evaluate(()=>fixture.exportAsks),1);
  await page.evaluate(async()=>{fixture.acceptExport(true);await fixture.exportPending;});
  const exported=await page.evaluate(()=>fixture.downloads);assert.equal(exported.length,1);assert.equal(exported[0].payload.records.length,51);
  assert.ok(exported[0].payload.records.every(r=>r.id!=='collection-50'&&r.id!=='collection-99'));assert.equal(await page.evaluate(()=>fixture.releases),1);
  assert.equal(await page.locator('[data-storage-export="collections"]').isDisabled(),false);
  checks.push('central export row starts one complete account snapshot download after confirmation without tombstones or duplicate clicks');
  for(const mode of ['account','dispose']){
    await page.evaluate(()=>{fixture.namespace='st-user:alice';fixture.acceptExport=null;fixture.exportPending=fixture.runExport();});await page.waitForFunction(()=>fixture.acceptExport!==null);
    await page.evaluate(async mode=>{if(mode==='account')fixture.namespace='st-user:bob';else fixture.floorTools.dispose();fixture.acceptExport(true);await fixture.exportPending;},mode);
    assert.equal(await page.evaluate(()=>fixture.downloads.length),1);assert.equal(await page.locator('[data-storage-export="collections"]').isDisabled(),false);
  }
  assert.equal(await page.evaluate(()=>fixture.releases),3);
  checks.push('account change and owner disposal while confirming export release controls without downloading old-account content');
  const restorePayload={type:'qianmu-text-collections',version:1,sourceAccount:expectedAccount,libraryRevision:2,exportedAt:2,records:[make('collection-101').record,make('collection-102').record]};
  await page.evaluate(payload=>{
    fixture.namespace='st-user:alice';fixture.restoreConsent=true;fixture.restoreAsks=[];
    fixture.openRestore=value=>{
      const input=document.querySelector('[data-storage-import="collections"]');input.closest('details').open=true;fixture.restoreInput=input;
      const file=new File([typeof value==='string'?value:JSON.stringify(value)],'<backup>.json',{type:'application/json'});
      fixture.restorePending=fixture.floorTools.restoreBackup(file,input,async(title,message)=>{fixture.restoreAsks.push({title,message});return fixture.restoreConsent;},()=>{const check=()=>{if(!input.isConnected)throw Error('parent closed');};check.release=()=>fixture.releases++;return check;});
    };fixture.openRestore(payload);
  },restorePayload);await ready();
  assert.equal(await page.evaluate(()=>fixture.floorTools.restoreBusy),true);assert.equal(await page.locator('[data-collection-restore-file]').textContent(),'<backup>.json');
  for(const width of [320,393,1280]){await page.setViewportSize({width,height:850});const size=await page.locator('dialog').evaluate(node=>({width:node.getBoundingClientRect().width,scroll:node.scrollWidth,client:node.clientWidth}));assert.ok(size.width<=width&&size.scroll<=size.client+1);}
  const restoreButton=page.locator('[data-collection-restore="run"]'),closeRestore=page.locator('[data-collection-restore="close"]'),beforeRestore=writes.length;
  loseAck=true;await restoreButton.click();await ready();assert.match(await status(),/已确认 0 \/ 2.*回执未确认/);
  const restoreRequest=structuredClone(writes.at(-1));assert.equal(restoreRequest.mutations.length,2);assert.ok(restoreRequest.mutations.every(r=>r.operation==='restore'));
  await page.evaluate(()=>{fixture.restoreConsent=false;});await closeRestore.click();assert.equal(await page.locator('dialog').count(),1);
  await page.evaluate(()=>{fixture.restoreConsent=true;});await restoreButton.click();await ready();assert.match(await status(),/已确认 2 \/ 2.*恢复完成/);
  assert.deepEqual(writes[beforeRestore],writes[beforeRestore+1]);assert.equal(writes.length-beforeRestore,2);assert.equal((await service.list(request,{version:1,expectedAccount,cursor:null,limit:50})).total,53);
  assert.equal(await restoreButton.isDisabled(),true);await closeRestore.click();await page.evaluate(()=>fixture.restorePending);
  assert.equal(await page.evaluate(()=>fixture.floorTools.restoreBusy),false);assert.equal(await page.locator('[data-storage-import="collections"]').isDisabled(),false);
  checks.push('restore dialog stays bounded on both layouts, retains lost-ack progress, confirms early exit and retries one identity into exactly two copies');
  const beforeInvalid=writes.length;await page.evaluate(()=>fixture.openRestore('broken json'));await ready();assert.match(await status(),/未开始恢复/);assert.equal(await restoreButton.isDisabled(),true);await closeRestore.click();await page.evaluate(()=>fixture.restorePending);assert.equal(writes.length,beforeInvalid);
  await page.evaluate(payload=>{fixture.restoreConsent=false;fixture.openRestore(payload);},restorePayload);await ready();await restoreButton.click();await ready();assert.match(await status(),/未开始恢复/);assert.equal(writes.length,beforeInvalid);await closeRestore.click();await page.evaluate(()=>fixture.restorePending);
  await page.evaluate(payload=>fixture.openRestore(payload),restorePayload);await ready();await page.evaluate(()=>fixture.floorTools.dispose());await page.waitForFunction(()=>!document.querySelector('dialog'));await page.evaluate(()=>fixture.restorePending);assert.equal(writes.length,beforeInvalid);
  checks.push('invalid backups, declined restore and owner disposal do not write; all restore portals and busy ownership are released');
  const inventory=await page.evaluate(async()=>{
    const data=await fixture.floorTools.storageSummary(()=>true);
    const {renderStorageBackupSection}=await import('./qianmu-storage-backup-view.js');
    const host=document.createElement('section');host.id='inventory';host.style.width='100%';host.innerHTML=renderStorageBackupSection(null,value=>`${value} B`,{data:{collectionStorage:data}});document.body.append(host);host.querySelector('details').open=true;return data;
  });assert.equal(inventory.count,53);assert.equal(inventory.deletedCount,2);assert.equal(inventory.bytes,(await fs.stat(path.join(folder,'.qianmu-text-collection-v1.json'))).size);assert.equal(writes.length,beforeInvalid);
  assert.match(await page.locator('#inventory .sd-storage-collection-summary').textContent(),/53 条原件.*不计入浏览器配额/);
  for(const width of [320,393,1280]){await page.setViewportSize({width,height:850});const size=await page.locator('#inventory .sd-storage-collection-summary').evaluate(node=>({scroll:node.scrollWidth,client:node.clientWidth}));assert.ok(size.scroll<=size.client+1);}
  checks.push('lazy server inventory shows exact file bytes and tombstone counts without writes or narrow-screen overflow');
  await page.evaluate(()=>{
    fixture.cleanupConsent=false;fixture.cleanupAsks=[];fixture.cleanupHost=document.createElement('section');document.body.append(fixture.cleanupHost);
    fixture.openCleanup=()=>{fixture.cleanupPending=fixture.floorTools.cleanupOriginals(fixture.cleanupHost,async(...args)=>{fixture.cleanupAsks.push(args);return fixture.cleanupConsent;},()=>{if(!fixture.cleanupHost.isConnected)throw Error('closed');},'st-user:alice',2);};fixture.openCleanup();
  });await ready();assert.equal(await page.locator('dialog').getAttribute('data-collection-operation'),'cleanup');
  const beforeCleanup=writes.length;await restoreButton.click();await ready();assert.equal(writes.length,beforeCleanup);assert.match(await status(),/未开始清理/);
  assert.match(await page.locator('dialog main').textContent(),/其他 2 个模块本次不执行/);
  assert.match(await page.evaluate(()=>fixture.cleanupAsks[0][1]),/不可恢复.*53 条收藏原件/);
  await closeRestore.click();await page.evaluate(()=>fixture.cleanupPending);
  checks.push('collection cleanup is separately confirmed with exact account count and skipped-module warnings; declining writes nothing');
  await page.evaluate(()=>{fixture.cleanupConsent=true;fixture.openCleanup();});await ready();
  await service.write(request,make('collection-100'));const changed=(await service.get(request,{version:1,expectedAccount,id:'collection-1'})).record;
  await service.write(request,{version:1,expectedAccount,mutationId:randomUUID(),operation:'edit',id:changed.id,baseRevision:changed.revision,text:'另一端修改，不可强删'});
  await restoreButton.click();await ready();assert.match(await status(),/其他设备变更/);assert.equal((await service.list(request,{version:1,expectedAccount,cursor:null,limit:50})).total,54);
  await closeRestore.click();await page.evaluate(()=>fixture.cleanupPending);
  checks.push('cleanup refuses an edited revision without clearing the batch or adopting newly added originals');
  await page.evaluate(()=>fixture.openCleanup());await ready();await service.write(request,make('collection-101'));
  const beforeLoss=writes.length;loseAck=true;await restoreButton.click();await ready();assert.match(await status(),/已确认 0 \/ 54.*当前批次回执未确认/);
  assert.equal((await service.list(request,{version:1,expectedAccount,cursor:null,limit:50})).total,23);
  await page.evaluate(()=>{fixture.cleanupConsent=false;});await closeRestore.click();assert.equal(await page.locator('dialog').count(),1);
  await page.evaluate(()=>{fixture.cleanupConsent=true;});await restoreButton.click();await ready();assert.match(await status(),/已确认 54 \/ 54.*清理完成/);
  assert.deepEqual(writes[beforeLoss],writes[beforeLoss+1]);assert.equal(writes.length-beforeLoss,3);
  assert.deepEqual((await service.list(request,{version:1,expectedAccount,cursor:null,limit:50})).items.map(r=>r.id),['collection-101']);
  for(const width of [320,393,1280]){await page.setViewportSize({width,height:850});const size=await page.locator('dialog').evaluate(n=>({scroll:n.scrollWidth,client:n.clientWidth,width:n.getBoundingClientRect().width}));assert.ok(size.width<=width&&size.scroll<=size.client+1);}
  await closeRestore.click();await page.evaluate(()=>fixture.cleanupPending);
  checks.push('lost cleanup acknowledgement retries the identical batch, preserves later additions and shows bounded confirmed progress on both layouts');
  const beforeDispose=writes.length;await page.evaluate(()=>fixture.openCleanup());await ready();await page.evaluate(()=>fixture.floorTools.dispose());await page.waitForFunction(()=>!document.querySelector('dialog'));await page.evaluate(()=>fixture.cleanupPending);
  assert.equal(writes.length,beforeDispose);assert.equal(await page.locator('[data-qm-text-collection-portal]').count(),0);
  checks.push('runtime cleanup closes the collection cleanup dialog and releases its portal without extra deletion');
  const pendingSeeds=Array.from({length:51},(_,i)=>make(`collection-${102+i}`));
  await page.evaluate(async inputs=>{
    const {createTextCollectionOutboxStore,createTextCollectionOutboxEntry}=await import('./qianmu-text-collection-outbox-store.js');const store=createTextCollectionOutboxStore();
    try{await store.update(inputs[0].expectedAccount,state=>{for(const [index,input] of inputs.entries())state.entries.push(createTextCollectionOutboxEntry(input,{queuedAt:index+1}));});}finally{store.close();}
  },pendingSeeds);
  failListOnce=true;await page.evaluate(()=>fixture.open());await ready();assert.match(await status(),/中断|损坏/);
  const pendingRoot=page.locator('[data-collection-outbox]'),pendingButton=name=>pendingRoot.locator(`[data-pending-action="${name}"]`);
  const pendingReady=()=>page.waitForFunction(()=>document.querySelector('[data-collection-outbox]')?.getAttribute('aria-busy')==='false');
  const beforePending=writes.length;await button('pending').click();await pendingReady();assert.equal(await pendingRoot.locator('[data-pending-id]').count(),50);
  await pendingButton('next').click();await pendingReady();assert.equal(await pendingRoot.locator('[data-pending-id]').count(),2);await pendingButton('prev').click();await pendingReady();
  await pendingRoot.locator(`[data-pending-id="${pending[0].request.mutationId}"]`).click();await pendingReady();
  assert.equal(await pendingButton('retry').isDisabled(),true);assert.equal(await pendingRoot.locator('textarea').inputValue(),'不要丢失的本机修改');
  await pendingButton('copy').click();await pendingReady();assert.equal(await page.evaluate(()=>fixture.copied),'不要丢失的本机修改');assert.equal(writes.length,beforePending);
  for(const width of [320,393,1280]){await page.setViewportSize({width,height:850});const size=await pendingRoot.evaluate(n=>({scroll:n.scrollWidth,client:n.clientWidth,width:n.getBoundingClientRect().width}));assert.ok(size.width<=width&&size.scroll<=size.client+1);}
  checks.push('local pending entry remains usable when server list fails, paginates 50 originals, copies conflict text without requests and fits both layouts');
  await pendingButton('back').click();await pendingReady();const retried=pendingSeeds.at(-1);await pendingRoot.locator(`[data-pending-id="${retried.mutationId}"]`).click();await pendingReady();
  loseAck=true;await pendingButton('retry').click();await pendingReady();assert.equal(await pendingRoot.locator('textarea').inputValue(),retried.record.text.replace(/\r\n?/g,'\n'));
  const sent=structuredClone(writes.at(-1));await pendingButton('close').click();await ready();await button('close').click();await page.evaluate(()=>fixture.open());await ready();
  await button('pending').click();await pendingReady();await pendingRoot.locator(`[data-pending-id="${retried.mutationId}"]`).click();await pendingReady();await pendingButton('retry').click();await pendingReady();
  assert.deepEqual(writes.at(-1),sent);assert.match(await pendingRoot.locator('[data-pending-status]').textContent(),/服务器已确认/);
  assert.equal((await service.list(request,{version:1,expectedAccount,cursor:null,limit:50})).total,2);
  checks.push('pending retry after closing and reopening confirms the same real server write exactly once despite a lost acknowledgement');
  const uncertain=pendingSeeds.at(-2),stale=pendingSeeds.at(-3),closed=pendingSeeds.at(-4),beforeLocalRemove=writes.length;
  await page.evaluate(async input=>{const {createTextCollectionOutboxStore}=await import('./qianmu-text-collection-outbox-store.js');const store=createTextCollectionOutboxStore();try{await store.update(input.expectedAccount,state=>{state.entries.find(row=>row.request.mutationId===input.mutationId).started=true;});}finally{store.close();}},uncertain);
  await pendingRoot.locator(`[data-pending-id="${uncertain.mutationId}"]`).click();await pendingReady();await page.evaluate(()=>{fixture.consent=false;});await pendingButton('remove').click();await pendingReady();assert.match(await pendingRoot.locator('[data-pending-status]').textContent(),/未移除/);
  assert.match(await page.evaluate(()=>fixture.lastConfirm[1]),/结果未知.*不等于取消原请求/);
  await page.evaluate(()=>{fixture.consent=true;});await pendingButton('remove').click();await pendingReady();assert.match(await pendingRoot.locator('[data-pending-status]').textContent(),/已移除此机待存，未删除服务器/);
  assert.equal(writes.length,beforeLocalRemove);assert.equal((await service.list(request,{version:1,expectedAccount,cursor:null,limit:50})).total,2);
  checks.push('local pending removal requires confirmation with unknown-result warning and never sends a server deletion');
  await pendingRoot.locator(`[data-pending-id="${stale.mutationId}"]`).click();await pendingReady();
  await page.evaluate(async input=>{const {createTextCollectionOutboxStore}=await import('./qianmu-text-collection-outbox-store.js');const store=createTextCollectionOutboxStore();try{await store.update(input.expectedAccount,state=>{state.entries.find(row=>row.request.mutationId===input.mutationId).started=true;});}finally{store.close();}},stale);
  await pendingButton('remove').click();await pendingReady();assert.match(await pendingRoot.locator('[data-pending-status]').textContent(),/状态已在另一页面变化/);
  await pendingButton('back').click();await pendingReady();await pendingRoot.locator(`[data-pending-id="${closed.mutationId}"]`).click();await pendingReady();
  await page.evaluate(()=>{fixture.holdConfirm=true;});await pendingButton('remove').click();await page.waitForFunction(()=>typeof fixture.acceptConfirm==='function');await pendingButton('close').click();await page.evaluate(()=>{fixture.acceptConfirm(true);fixture.holdConfirm=false;});await ready();
  await button('pending').click();await pendingReady();assert.equal(await pendingRoot.locator(`[data-pending-id="${closed.mutationId}"]`).count(),1);assert.equal(await pendingRoot.locator(`[data-pending-id="${stale.mutationId}"]`).count(),1);assert.equal(writes.length,beforeLocalRemove);
  checks.push('changed snapshots and closing while confirmation is pending preserve the original local rows');
  await pendingRoot.locator(`[data-pending-id="${pending[0].request.mutationId}"]`).click();await pendingReady();const beforeCopy=writes.length;
  await page.evaluate(()=>{fixture.consent=false;});await pendingButton('keep-copy').click();await pendingReady();assert.match(await pendingRoot.locator('[data-pending-status]').textContent(),/未创建副本/);assert.equal(writes.length,beforeCopy);
  await page.evaluate(()=>{fixture.consent=true;});rejectDraftCopy=true;await pendingButton('keep-copy').click();await pendingReady();assert.match(await pendingRoot.locator('[data-pending-status]').textContent(),/后端未接受副本格式.*本机内容仍保留/);assert.equal(await pendingRoot.locator('textarea').inputValue(),'不要丢失的本机修改');
  const copyRequest=structuredClone(writes.at(-1));assert.equal(copyRequest.record.revision,2);assert.equal(copyRequest.text,'不要丢失的本机修改');
  rejectDraftCopy=false;loseAck=true;await pendingButton('keep-copy').click();await pendingReady();assert.deepEqual(writes.at(-1),copyRequest);
  await pendingButton('close').click();await ready();await button('pending').click();await pendingReady();
  await pendingRoot.locator(`[data-pending-id="${pending[0].request.mutationId}"]`).click();await pendingReady();await pendingButton('keep-copy').click();await pendingReady();assert.deepEqual(writes.at(-1),copyRequest);
  assert.match(await pendingRoot.locator('[data-pending-status]').textContent(),/新副本已保存，原收藏未覆盖/);
  assert.equal(await pendingRoot.locator(`[data-pending-id="${pending[0].request.mutationId}"]`).count(),0);assert.equal(await pendingRoot.locator(`[data-pending-id="${copyRequest.mutationId}"]`).count(),0);
  const newCopy=(await service.get(request,{version:1,expectedAccount,id:copyRequest.id})).record;assert.equal(newCopy.text,'不要丢失的本机修改');assert.equal(newCopy.restoredFrom.revision,2);assert.equal(newCopy.restoredFrom.id,'collection-50');assert.equal(newCopy.createdAt,pending[0].base.createdAt);assert.equal(newCopy.source.charName,pending[0].base.source.charName);
  assert.equal((await service.get(request,{version:1,expectedAccount,id:'collection-50'})).record,null);assert.equal((await service.list(request,{version:1,expectedAccount,cursor:null,limit:50})).total,3);
  checks.push('explicit conflict copy preserves draft/source/date through old-backend rejection and lost receipts, creates only one copy and never resurrects the deleted original');
  await page.evaluate(()=>fixture.floorTools.dispose());await page.waitForFunction(()=>!document.querySelector('dialog'));
  checks.push('owner disposal closes both nested pending and library dialogs without removing device originals');
  assert.equal(external,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({count:checks.length,checks,pageErrors:errors,externalRequests:external,productionWrites:false,persistence:'real account-file service in temporary directory; browser transport intercepted; synthetic login, not live ST'},null,2));
}finally{
  await context.close();await browser.close();await service.close();const real=await fs.realpath(root);assert.equal(path.dirname(real),temporary);assert.match(path.basename(real),/^qianmu-collection-library-/);await fs.rm(real,{recursive:true});
}
