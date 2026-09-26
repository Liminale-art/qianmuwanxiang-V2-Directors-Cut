// Actual library UI -> native transport -> Node service -> temporary ST-native
// v2 files. Synthetic login and intercepted same-origin HTTP only, not live ST.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createTextCollection} from '../qianmu-text-collection.js';
import {createTextCollectionNativeService} from '../qianmu-text-collection-native-service.js';
import {createTextCollectionNativeFileStore} from '../qianmu-text-collection-native-file-store.js';
import {createTextCollectionOriginalStore} from '../qianmu-text-collection-original.js';
import {textCollectionSyncErrorPayload} from '../qianmu-text-collection-sync-contract.js';

const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const sha=value=>createHash('sha256').update(value).digest('hex'),namespace='st-user:native-ui-fixture',expectedAccount='st-user:'+sha('native-ui-fixture');
const schema='qianmu.st-account-document.v1',scope=sha(`${schema}\0${namespace}`);
const temporary=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(temporary,'qianmu-native-ui-'));
const accountRoot=path.join(root,'native-ui-fixture'),folder=path.join(accountRoot,'files');await fs.mkdir(folder,{recursive:true});
const request={user:{profile:{handle:'native-ui-fixture'},directories:{root:accountRoot,files:folder}}};
const service=createTextCollectionNativeService({dataRoot:root,now:()=>100});
const initial={version:2,expectedAccount,revision:0,entries:[],receipts:[]},head=path.join(folder,`qianmu-v2-${scope}-collections.json`);
const initialText=JSON.stringify({schema,scope,slot:'collections',value:initial}),initialFingerprint=sha(initialText);
await fs.writeFile(path.join(folder,`qianmu-v2-${scope}-collections-${initialFingerprint}.json`),initialText);
await fs.writeFile(head,JSON.stringify({schema:'qianmu.st-account-head.v1',scope,slot:'collections',fingerprint:initialFingerprint}));
const original=createTextCollection({id:'collection-native-ui',mode:'full',createdAt:10,source:{account:expectedAccount,chatId:'test-only',messageId:0,replyId:'swipe:0',
  charName:'角色',userName:'读者',text:'第一段😀\r\n\r\n第二段：保持原始换行\n\n第三段　全角空格'}});
const created=await service.write(request,{version:1,expectedAccount,mutations:[{version:1,expectedAccount,mutationId:randomUUID(),operation:'create',id:original.id,baseRevision:0,record:original}]});
const oldDescriptor=created.verified.value.entries[0],oldFile=path.join(folder,`qianmu-v2-${scope}-collection-record-${oldDescriptor.original.fingerprint}.json`),oldBytes=await fs.readFile(oldFile);
const edited='保存后第一段😀\n\n保存后第二段：中英 Alpha 42\n\n　首行全角空格与末段 ';
const checks=[],errors=[],writes=[];let gets=0,originalGets=0,firstChangedDetailFileGets=null,uploads=0,external=0,capabilities=0,releaseWrite=null;
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext(),page=await context.newPage();
const deadline=setTimeout(()=>void browser.close(),60000);page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url()),method=route.request().method();
  if(url.origin!=='https://qianmu.test'){external++;return route.abort();}
  if(url.pathname==='/'&&method==='GET')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="root"></main>'});
  if(/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)&&method==='GET')return route.fulfill({contentType:'text/javascript',body:await fs.readFile(new URL('..'+url.pathname,import.meta.url),'utf8')});
  if(url.pathname==='/api/plugins/qianmu-tts/text-collections/native-capabilities'&&method==='GET'){
    capabilities++;assert.equal(route.request().headers()['x-csrf-token'],'fixture-only');
    return route.fulfill({contentType:'application/json',body:JSON.stringify(service.capabilities(request))});
  }
  if(url.pathname==='/api/plugins/qianmu-tts/text-collections/native-write'&&method==='POST'){
    assert.equal(route.request().headers()['x-csrf-token'],'fixture-only');assert.equal(route.request().headers().authorization,undefined);
    const input=route.request().postDataJSON();writes.push(input);
    await new Promise(resolve=>{releaseWrite=resolve;});
    try{return route.fulfill({contentType:'application/json',body:JSON.stringify(await service.write(request,input))});}
    catch(cause){const failure=textCollectionSyncErrorPayload(cause);return route.fulfill({status:failure.status,contentType:'application/json',body:JSON.stringify(failure.body)});}
  }
  if(url.pathname.startsWith('/user/files/')&&method==='GET'){
    const name=url.pathname.split('/').at(-1);assert.match(name,new RegExp(`^qianmu-v2-${scope}-(?:collections|collection-record)(?:-[a-f0-9]{64})?\\.json$`));
    gets++;if(name.includes('-collection-record-'))originalGets++;
    let body;try{body=await fs.readFile(path.join(folder,name),'utf8');}catch(cause){if(cause.code!=='ENOENT')throw cause;}
    return route.fulfill({status:body===undefined?404:200,contentType:'application/json',body:body??'{}'});
  }
  if(url.pathname==='/api/files/upload'){uploads++;return route.abort();}
  external++;return route.abort();
});
const action=name=>page.locator(`[data-collection-manage="${name}"]`);
const ready=()=>page.waitForFunction(()=>document.querySelector('dialog')?.getAttribute('aria-busy')==='false');
try{
  await page.setViewportSize({width:393,height:850});await page.goto('https://qianmu.test/');
  await page.addStyleTag({content:await fs.readFile(new URL('../style.css',import.meta.url),'utf8')+'\n'+await fs.readFile(new URL('../qianmu-text-collection.css',import.meta.url),'utf8')});
  await page.evaluate(async namespace=>{
    window.fixture={namespace,active:true};
    const {configureStAccountStorage}=await import('/qianmu-st-account-storage.js'),{openTextCollectionLibrary}=await import('/qianmu-text-collection-library.js');
    configureStAccountStorage({resolveNamespace:async()=>fixture.namespace,isCurrent:()=>fixture.active,headers:()=>({'X-CSRF-Token':'fixture-only'})});
    fixture.open=async()=>{fixture.ui=await openTextCollectionLibrary({parent:document.getElementById('root'),resolveNamespace:async()=>fixture.namespace,
      isCurrent:()=>fixture.active,headers:()=>({'X-CSRF-Token':'fixture-only'}),copy:text=>{fixture.copied=text;}});};
    await fixture.open();
  },namespace);await ready();assert.equal(await page.locator('[data-collection-id]').count(),1);
  await page.locator('[data-collection-id]').click();await ready();await action('copy').click();await ready();
  assert.equal(await page.evaluate(()=>fixture.copied),original.text);
  assert.deepEqual(await page.locator('[data-collection-prose] p').allTextContents(),['第一段😀','第二段：保持原始换行','第三段　全角空格']);
  checks.push('real native-v2 list/detail render all original paragraphs and copying preserves exact CRLF/plaintext');
  await action('edit').click();await ready();await page.locator('[data-collection-editor]').fill(edited);await action('save').click();
  await page.waitForFunction(()=>document.querySelector('dialog')?.getAttribute('aria-busy')==='true');
  for(let attempt=0;!releaseWrite&&attempt<200;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(typeof releaseWrite,'function');
  assert.equal(await action('save').isDisabled(),true);assert.doesNotMatch(await page.locator('[data-collection-status]').textContent(),/修改已保存/);
  assert.equal(capabilities,1);assert.equal(writes.length,1);assert.equal(uploads,0);
  const input=writes[0];assert.equal(input.mutations.length,1);assert.equal(input.mutations[0].operation,'edit');
  assert.equal(input.mutations[0].baseRevision,1);assert.equal(input.mutations[0].text,edited);
  releaseWrite();releaseWrite=null;await ready();assert.match(await page.locator('[data-collection-status]').textContent(),/修改已保存/);
  await action('copy').click();await ready();assert.equal(await page.evaluate(()=>fixture.copied),edited);
  checks.push('the clicked save icon waits for acknowledgement: one capability GET + one native-write POST, never browser file uploads');
  const store=createTextCollectionNativeFileStore({dataRoot:root,request,expectedAccount});
  const verified=await store.read('collections'),saved=await createTextCollectionOriginalStore({storage:store,expectedAccount}).read(verified.value.entries[0]);
  assert.equal(saved.record.text,edited);assert.equal(saved.record.revision,2);assert.deepEqual(saved.record.source,original.source);
  assert.deepEqual(await fs.readFile(oldFile),oldBytes);assert.notEqual(verified.value.entries[0].original.fingerprint,oldDescriptor.original.fingerprint);
  checks.push('actual Node service writes the new complete original and verified v2 head while keeping the old original bytes and source metadata');
  await action('close').click();gets=0;originalGets=0;await page.evaluate(()=>fixture.open());await ready();
  assert.equal(gets,0,'closing immediately after save must not reread the list directory');
  assert.match(await page.locator('[data-collection-id] small').textContent(),/保存后第一段/);
  await page.locator('[data-collection-id]').click();await ready();firstChangedDetailFileGets=gets;
  assert.equal(firstChangedDetailFileGets,1,'the changed original needs one exact body GET, without rereading the already verified directory');
  assert.equal(originalGets,1,'first reading of the changed immutable original verifies that exact body once');
  await action('copy').click();await ready();assert.equal(await page.evaluate(()=>fixture.copied),edited);
  assert.deepEqual(await page.locator('[data-collection-prose] p').allTextContents(),['保存后第一段😀','保存后第二段：中英 Alpha 42','　首行全角空格与末段 ']);
  await action('close').click();gets=0;await page.evaluate(()=>fixture.open());await ready();await page.locator('[data-collection-id]').click();await ready();
  assert.equal(gets,0);assert.equal(capabilities,1);assert.equal(writes.length,1);assert.equal(uploads,0);
  checks.push('immediate post-save list reopen needs zero GETs; after its one exact-body verification, repeated list/detail reopen also needs zero GETs');
  assert.equal(external,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({count:checks.length,checks,capabilityGets:capabilities,nativeWritePosts:writes.length,browserFileUploads:uploads,
    firstChangedDetailFileGets,finalReopenFileGets:gets,externalRequests:external,productionWrites:false,pageErrors:errors,
    scope:'actual library UI and Node native service, temporary account files and intercepted same-origin routes only'}));
}finally{
  releaseWrite?.();clearTimeout(deadline);await context.close();await browser.close();await service.close();
  const real=await fs.realpath(root);assert.equal(path.dirname(real),temporary);assert.match(path.basename(real),/^qianmu-native-ui-/);await fs.rm(real,{recursive:true});
}
