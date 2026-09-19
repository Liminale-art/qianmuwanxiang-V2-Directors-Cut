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
const allowed=new Set(['qianmu-notes-sync-contract.js','qianmu-text-collection.js','qianmu-json-input.js',...['backup','floor','library','session','client','sync-contract'].map(name=>`qianmu-text-collection-${name}.js`)]);
const checks=[],errors=[],writes=[];let reads=0,external=0,loseAck=false,failListOnce=false;
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'){
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="fixture"></main>'});
    if(url.pathname==='/qianmu-text-collection.css')return route.fulfill({contentType:'text/css',body:await fs.readFile(new URL('../qianmu-text-collection.css',import.meta.url),'utf8')});
    const file=url.pathname.slice(1);if(allowed.has(file))return route.fulfill({contentType:'text/javascript',body:await fs.readFile(new URL('../'+file,import.meta.url),'utf8')});
    const action=url.pathname.split('/').at(-1);
    if(url.pathname.startsWith('/api/plugins/qianmu-tts/text-collections/')&&['list','get','write'].includes(action)&&route.request().method()==='POST'){
      const input=route.request().postDataJSON();assert.equal(route.request().headers()['x-csrf-token'],'fixture-only');
      if(action==='list'&&failListOnce){failListOnce=false;return route.abort('failed');}
      if(action==='get')reads++;if(action==='write')writes.push(input);
      try{const result=await service[action](request,input);if(action==='write'&&loseAck){loseAck=false;return route.abort('failed');}return route.fulfill({contentType:'application/json',body:JSON.stringify(result)});}
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
      fixture.ui=await fixture.floorTools.openLibrary(fixture.host,async()=>fixture.consent,async text=>{fixture.copied=text;});};
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
  await page.evaluate(()=>{fixture.consent=false;});await button('reload').click();await ready();assert.equal(await page.locator('[data-collection-editor]').inputValue(),'不要丢失的本机修改');
  await button('close').click();assert.equal(await page.locator('dialog').count(),1);
  await page.locator('[data-collection-editor]').focus();await page.keyboard.press('Escape');assert.equal(await page.locator('dialog').count(),1);assert.equal(await page.evaluate(()=>fixture.escaped),0);
  await page.evaluate(()=>{fixture.consent=true;});await button('reload').click();await ready();assert.equal(await page.locator('[data-collection-editor]').inputValue(),'另一端修改');
  checks.push('revision conflicts preserve the local draft and explicit discard confirmation gates reload or close');
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
  assert.equal(external,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({count:checks.length,checks,pageErrors:errors,externalRequests:external,productionWrites:false,persistence:'real account-file service in temporary directory; browser transport intercepted; synthetic login, not live ST'},null,2));
}finally{
  await context.close();await browser.close();await service.close();const real=await fs.realpath(root);assert.equal(path.dirname(real),temporary);assert.match(path.basename(real),/^qianmu-collection-library-/);await fs.rm(real,{recursive:true});
}
