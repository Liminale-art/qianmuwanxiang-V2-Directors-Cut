// Actual collection UI + native ST-file client; only transport/account are fixtures.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {createTextCollection,textCollectionRecord} from '../qianmu-text-collection.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const hash=value=>createHash('sha256').update(value).digest('hex'),namespace='st-user:warm-fixture',account='st-user:'+hash('warm-fixture');
const schema='qianmu.st-account-document.v1',scope=hash(`${schema}\0${namespace}`),files=new Map();
let record=createTextCollection({id:'collection-warm1',mode:'full',createdAt:1,source:{account,chatId:'test-only',messageId:0,replyId:'reply-1',charName:'角色',userName:'读者',text:'第一段\n\n\n\n第二段'}});
function seed(){
 const value={version:1,expectedAccount:account,revision:record.revision,entries:[{id:record.id,revision:record.revision,updatedAt:record.updatedAt,deleted:false,record}],receipts:[]};
 const text=JSON.stringify({schema,scope,slot:'collections',value}),fingerprint=hash(text),prefix=`qianmu-v2-${scope}-collections`;
 files.set(`${prefix}-${fingerprint}.json`,text);files.set(`${prefix}.json`,JSON.stringify({schema:'qianmu.st-account-head.v1',scope,slot:'collections',fingerprint}));
}
seed();let gets=0,posts=0,external=0,hold=false,release=null,entered=null,rejected=false;
const rttMs=40;
const checks=[],errors=[],browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext(),page=await context.newPage();
const deadline=setTimeout(()=>void browser.close(),90000);
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
 const url=new URL(route.request().url());
 if(url.origin!=='https://qianmu.test'){external++;return route.abort();}
 if(url.pathname==='/api/plugins/qianmu-tts/text-collections/native-capabilities'&&route.request().method()==='GET')return route.fulfill({status:404,contentType:'application/json',body:'{}'});
 if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="root"></main>'});
 if(/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url),'utf8')});
 if(url.pathname.startsWith('/user/files/')){
  await new Promise(resolve=>setTimeout(resolve,rttMs));
  if(rejected)return route.fulfill({status:401,contentType:'application/json',body:'{}'});
  gets++;if(hold){hold=false;entered?.();await new Promise(resolve=>{release=resolve;});}
  const text=files.get(url.pathname.split('/').at(-1));return route.fulfill({status:text?200:404,contentType:'application/json',body:text||'{}'});
 }
 if(url.pathname==='/api/files/upload'){posts++;return route.abort();}
 external++;return route.abort();
});
const ready=()=>page.waitForFunction(()=>document.querySelector('dialog')?.getAttribute('aria-busy')==='false');
const click=action=>page.locator(`[data-collection-manage="${action}"]`).click();
try{
 await page.setViewportSize({width:393,height:850});await page.goto('https://qianmu.test/');
 await page.addStyleTag({content:await readFile(new URL('../style.css',import.meta.url),'utf8')+'\n'+await readFile(new URL('../qianmu-text-collection.css',import.meta.url),'utf8')+'\n.qm-text-collection-library > main {height:100px;flex:none!important}.qm-text-collection-library .qm-text-collection-row {min-height:240px}'});
 await page.evaluate(async namespace=>{
  window.fixture={namespace,active:true,offset:0};const now=Date.now;Date.now=()=>now()+fixture.offset;
  const {configureStAccountStorage}=await import('/qianmu-st-account-storage.js'),{openTextCollectionLibrary}=await import('/qianmu-text-collection-library.js');
  configureStAccountStorage({resolveNamespace:async()=>fixture.namespace,isCurrent:()=>fixture.active,headers:()=>({})});
  fixture.open=async()=>{fixture.ui=await openTextCollectionLibrary({parent:document.getElementById('root'),resolveNamespace:async()=>fixture.namespace,isCurrent:()=>fixture.active,headers:()=>({}),copy:text=>{fixture.copied=text;}});};
  await fixture.open();
 },namespace);await ready();assert.equal(gets,2);assert.equal(await page.locator('[data-collection-id]').count(),1);checks.push('cold open reads the native head/body once');
 await click('close');gets=0;
 await page.evaluate(async()=>{
  const {createTextCollectionFloorStatus}=await import('/qianmu-text-collection-floor-status.js');
  const scope={chatId:'test-only',chat:[]};fixture.stars=createTextCollectionFloorStatus({getScope:()=>scope,resolveNamespace:async()=>fixture.namespace,isCurrent:()=>fixture.active});
  await fixture.stars.refresh();if(fixture.stars.status(0)!==true)throw Error('star source missing');
 });assert.equal(gets,0,'floor stars must not call the force-refresh backup path');
 const reopenAt=performance.now();await page.evaluate(()=>fixture.open());await ready();const reopenMs=performance.now()-reopenAt;assert.equal(gets,0);
 await page.evaluate(()=>{fixture.listRow=document.querySelector('[data-collection-id]');document.querySelector('[data-collection-list]').scrollTop=74;});
 assert.equal(await page.locator('[data-collection-list]').evaluate(element=>element.scrollTop),74);
 await page.evaluate(()=>fixture.listRow.click());await ready();assert.equal(gets,0);
 assert.equal(await page.locator('[data-collection-detail]').evaluate(element=>element.scrollTop),0);
 await click('copy');await ready();assert.equal(await page.evaluate(()=>fixture.copied),'第一段\n\n\n\n第二段');
 await click('edit');await ready();assert.equal(await page.locator('[data-collection-editor]').inputValue(),'第一段\n\n第二段');
 await click('save');await ready();assert.equal(posts,0,'display normalization is not an edit');
 await click('back');await ready();assert.equal(gets,0);checks.push('reopen/detail/copy/back use zero file GETs and preserve original blank lines when unedited');
 assert.equal(await page.evaluate(()=>document.querySelector('[data-collection-id]')===fixture.listRow),true);
 assert.equal(await page.locator('[data-collection-list]').evaluate(element=>element.scrollTop),74);checks.push('unchanged detail return retains the same row DOM and restores list scrolling');
 // A concurrent floor reader can lose its old chat epoch while its identity
 // await is still pending. That cancellation must not revoke this UI's shared
 // same-account directory when the library is closed and opened again.
 gets=0;await page.evaluate(async()=>{
  const {createTextCollectionSession}=await import('/qianmu-text-collection-session.js');
  fixture.oldReaderCurrent=true;fixture.holdOldIdentity=false;fixture.oldIdentityHeld=false;
  fixture.oldReader=await createTextCollectionSession({resolveNamespace:async()=>{
    if(fixture.holdOldIdentity){fixture.holdOldIdentity=false;fixture.oldIdentityHeld=true;await new Promise(resolve=>fixture.releaseOldIdentity=resolve);}
    return fixture.namespace;
  },isCurrent:()=>fixture.oldReaderCurrent,headers:()=>({})});
  await fixture.oldReader.sources();fixture.holdOldIdentity=true;
  fixture.oldRead=fixture.oldReader.sources().then(()=>{fixture.oldReadCode='unexpected-success';},error=>{fixture.oldReadCode=error.code;});
 });await page.waitForFunction(()=>fixture.oldIdentityHeld===true);await click('close');
 await page.evaluate(async()=>{fixture.oldReaderCurrent=false;fixture.releaseOldIdentity();await fixture.oldRead;fixture.oldReader.close();});
 assert.equal(await page.evaluate(()=>fixture.oldReadCode),'text_collection_sync_cancelled');
 await page.evaluate(()=>fixture.open());await ready();assert.equal(gets,0);
 assert.equal(await page.locator('[data-collection-id]').count(),1);
 await page.locator('[data-collection-id]').click();await ready();assert.equal(gets,0);await click('back');await ready();
 checks.push('a late cancelled floor lifecycle cannot evict another same-account library: close/reopen list and detail make zero file GETs');
 await click('close');record=textCollectionRecord({...record,revision:2,updatedAt:2,text:'远端的新文字'});seed();
 gets=0;await page.evaluate(()=>{fixture.offset+=60000;return fixture.open();});await ready();
 assert.equal(gets,0,'reopening an expired snapshot must not start a hidden revalidation');
 assert.equal(await page.locator('[data-collection-id]').count(),1);assert.match(await page.locator('[data-collection-id] small').textContent(),/第一段/);
 await page.locator('[data-collection-id]').click();await ready();assert.equal(await page.locator('[data-collection-prose]').textContent(),'第一段第二段');
 checks.push('expired snapshot reopens and opens detail without a hidden file revalidation');
 await click('back');await ready();assert.match(await page.locator('[data-collection-id] small').textContent(),/第一段/);
 checks.push('reopening and returning keeps the cached list until the user explicitly refreshes');
 await page.evaluate(()=>{fixture.listRow=document.querySelector('[data-collection-id]');});await click('refresh');await ready();assert.ok(gets>=2);
 assert.equal(await page.evaluate(()=>document.querySelector('[data-collection-id]')===fixture.listRow),true);assert.match(await page.locator('[data-collection-id] small').textContent(),/远端的新文字/);checks.push('explicit refresh remains authoritative and does not rebuild unchanged rows');
 await page.evaluate(()=>{fixture.namespace='st-user:other';});await page.locator('[data-collection-id]').click();await page.waitForFunction(()=>!document.querySelector('dialog'));
 checks.push('account changes close the old view rather than rendering its cached body');
 await page.evaluate(namespace=>{fixture.namespace=namespace;return fixture.open();},namespace);await ready();await click('close');
 rejected=true;await page.evaluate(()=>{fixture.offset+=60000;return fixture.open();});
 await page.waitForFunction(()=>!document.querySelector('dialog'));
 checks.push('background 401 closes the cached view even when ST still exposes the old account handle');
 assert.equal(posts,0);assert.equal(external,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:checks.length,checks,errors,external,writes:posts,rttMs,reopenMs,scope:'actual UI/native storage with floor-star refresh; intercepted local fixture files only, not real VPS timings'}));
}finally{release?.();clearTimeout(deadline);await context.close();await browser.close();}
