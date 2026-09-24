// Real archive controller -> archive session/native store -> ST file transport.
// Only account/context, isolated empty IDB, and same-origin file server are fixtures.
// All requests stay inside qianmu.test; writes, generation, and live ST are forbidden.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {emptyCharacterNativeIndex, CHARACTER_NATIVE_SLOT} from '../qianmu-character-native-contract.js';

const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const hash=value=>createHash('sha256').update(value).digest('hex');
const namespace='st-user:character-loading-fixture',schema='qianmu.st-account-document.v1',scope=hash(`${schema}\0${namespace}`);
const rttMs=60,files=new Map(),checks=[],measurements=[],errors=[],requests=[],allRequests=[],heldReads=new Set();
let external=0,writes=0,nextHold=null,rejected=false;
function seedIndex(index){
  const text=JSON.stringify({schema,scope,slot:CHARACTER_NATIVE_SLOT,value:index}),fingerprint=hash(text),prefix=`qianmu-v2-${scope}-${CHARACTER_NATIVE_SLOT}`;
  files.set(`${prefix}-${fingerprint}.json`,text);
  files.set(`${prefix}.json`,JSON.stringify({schema:'qianmu.st-account-head.v1',scope,slot:CHARACTER_NATIVE_SLOT,fingerprint}));
}
function indexWithName(name){
  const index=emptyCharacterNativeIndex(namespace);index.revision=1;
  // The list must only need validated directory metadata, never load this original.
  index.archives=[{head:{id:'fixture-record',revision:'fixture-revision',version:1,category:'char',name,aliases:[],cover:'',bytes:100,createdAt:1,updatedAt:1},
    original:{version:1,scope,slot:'character-record',fingerprint:'a'.repeat(64),bytes:200}}];
  index.usage={count:1,bytes:100,bindings:0};return index;
}
function holdNext(){
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),wait=new Promise(resolve=>{release=resolve;});
  const hold={started,release:()=>{release();heldReads.delete(hold);},wait,entered};heldReads.add(hold);nextHold=hold;return hold;
}
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const deadline=setTimeout(()=>void browser.close(),120000);
const context=await browser.newContext({viewport:{width:393,height:850}}),page=await context.newPage();
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!=='https://qianmu.test'){external++;return route.abort();}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="root"></main>'});
  if(/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url),'utf8')});
  if(url.pathname.startsWith('/user/files/')){
    if(route.request().method()!=='GET'){writes++;return route.abort();}
    requests.push(url.pathname);allRequests.push(url.pathname);const held=nextHold;if(held){nextHold=null;held.entered();await held.wait;}
    await new Promise(resolve=>setTimeout(resolve,rttMs));
    if(rejected)return route.fulfill({status:401,contentType:'application/json',body:'{}'});
    const text=files.get(url.pathname.split('/').at(-1));return route.fulfill({status:text?200:404,contentType:'application/json',body:text||'{}'});
  }
  if(url.pathname==='/api/files/upload'){writes++;return route.abort();}
  external++;return route.abort();
});
const ready=()=>page.waitForFunction(()=>document.querySelector('#host .sd-character-library[aria-busy="false"]'));
const idle=()=>page.waitForFunction(()=>fixture.metrics.inflight===0&&fixture.metrics.overviews>0);
const stable=async()=>{await idle();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
const ok=(name,value=true)=>{assert.ok(value,name);checks.push(name);};
const counters=()=>page.evaluate(()=>({...fixture.metrics}));
const click=action=>page.locator(`#host [data-archive-action="${action}"]`).first().click();
try{
  await page.goto('https://qianmu.test/');
  await page.addStyleTag({content:await readFile(new URL('../style.css',import.meta.url),'utf8')});
  await page.evaluate(async namespace=>{
    const {createCharacterArchiveController}=await import('/qianmu-character-archive-view.js');
    const {createCharacterArchiveStore}=await import('/qianmu-character-archive-store.js');
    const {configureStAccountStorage}=await import('/qianmu-st-account-storage.js');
    window.fixture={namespace,active:true,now:100000,scope:'fixture-chat',controller:null,metrics:null};
    fixture.open=()=>{
      const panel=document.createElement('section');panel.id='panel';panel.className='sd-storyboard-scroll';
      const host=document.createElement('div');host.id='host';panel.append(host);document.getElementById('root').replaceChildren(panel);
      fixture.controller.mount(host);
    };
    fixture.close=()=>{fixture.controller.detach();document.getElementById('panel')?.remove();};
    fixture.reset=()=>{
      fixture.controller?.dispose();fixture.namespace=namespace;fixture.active=true;fixture.now=100000;fixture.scope='fixture-chat';
      fixture.metrics={identities:0,contexts:0,overviews:0,inflight:0,migrationRequests:0,stores:0};
      const resolveNamespace=async()=>{fixture.metrics.identities++;return fixture.namespace;};
      configureStAccountStorage({resolveNamespace,isCurrent:()=>fixture.active,headers:()=>({})});
      const createStore=()=>{
        fixture.metrics.stores++;
        const store=createCharacterArchiveStore({native:{requestMigration:()=>{fixture.metrics.migrationRequests++;}}});
        return {...store,overview:async(...args)=>{
          fixture.metrics.overviews++;fixture.metrics.inflight++;
          try{return await store.overview(...args);}finally{fixture.metrics.inflight--;}
        }};
      };
      fixture.controller=createCharacterArchiveController({resolveNamespace,createStore,now:()=>fixture.now,
        getScope:()=>fixture.scope,isCurrent:()=>fixture.active,
        getContext:async()=>{fixture.metrics.contexts++;await new Promise(resolve=>setTimeout(resolve,15));return {chatKey:fixture.scope,subjects:[]};}});
      fixture.open();
    };
  },namespace);

  for(const existing of [false,true]){
    files.clear();if(existing)seedIndex(emptyCharacterNativeIndex(namespace));requests.length=0;
    const start=performance.now();await page.evaluate(()=>fixture.reset());await ready();await stable();
    const cold=await counters();
    assert.equal(requests.length,2,'cold empty library requires exactly two file GETs');assert.equal(cold.overviews,1);assert.equal(cold.contexts,1);
    ok(`${existing?'existing empty directory':'new empty library'}: one overview/context, two file GETs, explicit empty state`,/还没有/.test(await page.locator('#host').innerText()));
    measurements.push({case:existing?'existing-empty-cold':'missing-empty-cold',ms:+(performance.now()-start).toFixed(1),gets:requests.length,...cold});
    await page.evaluate(()=>fixture.close());requests.length=0;const before=await counters(),warmAt=performance.now();
    await page.evaluate(()=>{fixture.now+=29999;fixture.open();});await ready();await stable();const warm=await counters();
    assert.equal(requests.length,0);assert.equal(warm.overviews,before.overviews);assert.equal(warm.contexts-before.contexts,1);
    ok(`${existing?'existing':'missing'} empty directory: closing the whole panel then reopening before 30s keeps zero file GETs and rechecks live identity`,warm.identities>before.identities);
    measurements.push({case:existing?'existing-empty-warm':'missing-empty-warm',ms:+(performance.now()-warmAt).toFixed(1),gets:requests.length});
  }

  // Older snapshots must become usable before a deliberately held remote reply.
  await page.evaluate(()=>fixture.close());requests.length=0;let held=holdNext();
  await page.evaluate(()=>{fixture.now+=2;fixture.open();});await ready();await held.started;
  assert.equal((await counters()).overviews,2);assert.equal(requests.length,1);
  ok('after 30s, old empty snapshot is interactive while a single background head read is held',await page.locator('[data-archive-action="new"]').first().isEnabled());
  await click('new');await ready();await page.locator('[data-archive-field="name"]').fill('正在编辑的草稿');
  seedIndex(indexWithName('后台更新的档案'));held.release();await stable();
  assert.equal(await page.locator('[data-archive-field="name"]').inputValue(),'正在编辑的草稿');
  ok('background catalogue update never replaces an open draft or the text being edited');
  // A new isolated owner starts from the real remote directory to verify stale list painting.
  requests.length=0;await page.evaluate(()=>fixture.reset());await ready();await stable();assert.equal(requests.length,2);
  await page.evaluate(()=>fixture.close());requests.length=0;held=holdNext();seedIndex(indexWithName('新的远端名称'));
  await page.evaluate(()=>{fixture.now+=31000;fixture.open();});await ready();await held.started;
  assert.match(await page.locator('#host').innerText(),/后台更新的档案/);
  ok('an expired populated snapshot appears before the held server reply with no loading placeholder',!/正在读取角色库/.test(await page.locator('#host').innerText()));
  held.release();await page.waitForFunction(()=>document.getElementById('host')?.textContent.includes('新的远端名称'));await stable();
  assert.equal(requests.length,2);ok('background refresh validates one head/body pair then updates the current list');

  // Reopening while that background refresh is still pending must hand over its
  // just-validated result, not schedule a second read after the old owner exits.
  await page.evaluate(()=>fixture.close());requests.length=0;held=holdNext();const beforeRemount=await counters();
  seedIndex(indexWithName('后台读取期间重开的档案'));
  await page.evaluate(()=>{fixture.now+=31000;fixture.open();});await ready();await held.started;
  await page.evaluate(()=>{fixture.close();fixture.open();});await ready();
  assert.match(await page.locator('#host').innerText(),/新的远端名称/);
  held.release();await page.waitForFunction(()=>document.getElementById('host')?.textContent.includes('后台读取期间重开的档案'));await stable();
  assert.equal(requests.length,2,'reopening a pending background refresh must not read a second head/body pair');
  assert.equal((await counters()).overviews-beforeRemount.overviews,1);
  ok('closing and reopening during a background overview adopts its freshly live-authorized result without a second overview or head/body read');

  // Detached listeners still invalidate their remembered snapshot on native writes.
  await page.evaluate(()=>fixture.close());requests.length=0;seedIndex(indexWithName('隐藏时变更的档案'));
  await page.evaluate(()=>document.dispatchEvent(new CustomEvent('qianmu-character-library-changed')));
  assert.equal(requests.length,0);await page.evaluate(()=>fixture.open());await ready();await stable();
  assert.match(await page.locator('#host').innerText(),/隐藏时变更的档案/);assert.equal(requests.length,2);
  ok('a native change while the entire panel is closed invalidates the snapshot without reading in the background or double-reading on reopen');

  // A navigation rebuild while a cold read is pending shares that read.
  await page.evaluate(()=>fixture.controller.dispose());requests.length=0;held=holdNext();
  await page.evaluate(()=>fixture.reset());await held.started;await page.evaluate(()=>{fixture.close();fixture.open();fixture.controller.mount(document.getElementById('host'));});
  held.release();await ready();await stable();
  assert.equal(requests.length,2);assert.equal((await counters()).overviews,1);
  ok('detach/remount and repeated mount during a cold read share one real overview and one head/body pair');

  // Expiry is bounded; snapshots cannot become an indefinite account data cache.
  await page.evaluate(()=>fixture.close());requests.length=0;held=holdNext();
  await page.evaluate(()=>{fixture.now+=30*60*1000;fixture.open();});await held.started;
  ok('a 30-minute-old snapshot blocks until a fresh read rather than being reused',await page.locator('#host [aria-busy="true"]').count()===1);
  held.release();await ready();await stable();assert.equal(requests.length,2);

  // Authentication errors must revoke previously visible rows, even in background.
  await page.evaluate(()=>fixture.close());rejected=true;requests.length=0;
  await page.evaluate(()=>{fixture.now+=31000;fixture.open();});
  await page.waitForFunction(()=>document.querySelector('#host [role="alert"]')&&document.querySelectorAll('#host .sd-character-library').length===0);
  ok('a background 401 revokes the cached list and exposes a retry, not another account data',!/隐藏时变更的档案/.test(await page.locator('#host').innerText()));
  rejected=false;await click('refresh');await ready();await stable();ok('retry after authentication recovery really reloads the library');

  const prior=await counters();await page.evaluate(()=>fixture.close());requests.length=0;
  await page.evaluate(()=>{fixture.namespace='st-user:another-fixture';fixture.open();});
  await page.waitForFunction(()=>document.querySelector('#host [role="alert"]'));
  ok('account change before warm reopen discards the snapshot and rebuilds the owned store',!/隐藏时变更的档案/.test(await page.locator('#host').innerText())&&(await counters()).stores===prior.stores+1);
  assert.equal(requests.length,0,'old account files must not be requested after identity changes');

  await page.evaluate(()=>fixture.controller.dispose());assert.equal(writes,0);assert.equal(external,0);assert.deepEqual(errors,[]);
  assert.ok(!allRequests.some(path=>path.includes('-character-record-')),'list-only browsing must not read record originals');
  console.log(JSON.stringify({passed:checks.length,checks,measurements,rttMs,errors,external,writes,
    scope:'real controller/archive factory/session/native ST-file chain; synthetic account and 60ms file server, empty isolated IDB; no live VPS timing, actual storyboard owner integration, idle migration, reference images, or generation proof'}));
}finally{for(const held of heldReads)held.release();clearTimeout(deadline);await context.close();await browser.close();}
