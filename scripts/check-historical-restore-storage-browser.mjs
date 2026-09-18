// Actual record manager -> actual short-lived Worker -> actual IDB. Temporary
// account/chat fixture only; no production ST session or server writes.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { historicalChatSaveFixture } from '../tests/helpers/historical-chat-save-fixture.mjs';
const f=await historicalChatSaveFixture(),original=await fs.readFile(f.file),checks=[],errors=[],unexpected=[];
const modules=new Map(await Promise.all(JSON.parse(await fs.readFile(new URL('../release-files.json',import.meta.url))).files.filter(name=>/\.(js|css)$/.test(name))
  .map(async name=>['/'+name,await fs.readFile(new URL('../'+name,import.meta.url))])));
const server=http.createServer(async(req,res)=>{
  const route=new URL(req.url,'http://localhost').pathname;
  if(route==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="story-director-modal" class="open"></div></body></html>');return;}
  if(route==='/fixture'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(f.proposal));return;}
  if(route==='/favicon.ico'){res.writeHead(204);res.end();return;}
  if(modules.has(route)){res.writeHead(200,{'Content-Type':route.endsWith('.css')?'text/css':'application/javascript'});res.end(modules.get(route));return;}
  unexpected.push(route);res.writeHead(404);res.end();
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
const {chromium}=createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),contexts=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
async function device(){
  const context=await browser.newContext();contexts.push(context);
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){unexpected.push(route.request().url());return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);await setup(page);return page;
}
async function setup(page){
  await page.addStyleTag({url:origin+'/style.css'});await page.addStyleTag({url:origin+'/qianmu-theme-skins.css'});
  await page.addStyleTag({content:'body{margin:0}#story-director-modal{display:block!important;position:relative!important;inset:auto!important;transform:none!important;width:100%;height:100dvh}'});
  await page.evaluate(async()=>{
    window.proposal=await(await fetch('/fixture')).json();window.namespace=proposal.namespace;window.active=true;window.wire=[];window.workers=[];
    window.journal=(await import('/qianmu-storyboard-package-journal.js')).createStoryboardPackageJournal();
    window.makeRecord=(await import('/qianmu-historical-chat-journal.js')).createHistoricalChatMutation;
    const {runRestoreStorage}=await import('/qianmu-storyboard-restore-storage-runtime.js');
    class ObservedWorker extends Worker{constructor(...args){super(...args);workers.push(this);this.addEventListener('message',event=>wire.push(structuredClone(event.data)));}terminate(){this.wasTerminated=true;super.terminate();}}
    window.run=(action,input={})=>runRestoreStorage(action,{namespace,guard:async()=>{if(!active)throw Error('page ended');},WorkerClass:ObservedWorker,...input});
    window.summary=()=>run('inspect');
    window.manager=await import('/qianmu-storyboard-restore-storage-view.js');
    window.open=()=>{window.view=manager.openRestoreStorageManager({parent:document.getElementById('story-director-modal'),chatHash:'a'.repeat(64),run,formatBytes:value=>value+' B'});};
    window.select=row=>({kind:row.kind,key:row.key,fingerprint:row.fingerprint});
  });
}
const idle=page=>page.waitForFunction(()=>document.querySelector('dialog fieldset')&&!document.querySelector('dialog fieldset').disabled);
const historical=page=>page.locator('.sd-restore-storage-item').filter({hasText:'原聊天恢复记录'}).locator('input');
try{
  const a=await device();
  await a.evaluate(async()=>{
    window.record=await journal.prepareHistoricalChatMutation(await makeRecord(proposal),{confirmed:true});
    window.resource=await journal.prepareResource({namespace,kind:'characters',sourceDigest:'d'.repeat(64),planDigest:'e'.repeat(64)},{confirmed:true});
  });
  const first=await a.evaluate(async()=>window.initial=await summary());
  check('real Worker includes new historical row and old resource record in one bounded inventory',first.count===2&&first.items.some(row=>row.kind==='historical-chat')&&first.items.some(row=>row.kind==='characters'));
  check('inventory bytes count stored records, not referenced media',await a.evaluate(()=>initial.bytes===new Blob([JSON.stringify(record)]).size+new Blob([JSON.stringify(resource)]).size));
  check('raw proposals, character names and narrative never cross Worker replies',await a.evaluate(()=>!JSON.stringify(wire).match(/storyboardImages|characterDrafts|silver hair|original extension|PRIVATE_/)));
  check('historical target fingerprint cannot masquerade as legacy current-chat name',first.items.find(row=>row.kind==='historical-chat').chatHash===''&&/^[a-f0-9]{64}$/.test(first.items.find(row=>row.kind==='historical-chat').targetHash));
  check('inventory worker terminates after compact result',await a.evaluate(()=>workers.every(worker=>worker.wasTerminated)));
  check('fast existing-import gate detects pending intent without adopting or clearing it',await a.evaluate(async()=>{try{await journal.assertNoHistoricalChatMutation(namespace);return false;}catch(error){return error.message.includes('数据管理')&&await journal.hasMutation(namespace);}}));
  await a.evaluate(()=>open());await idle(a);
  check('actual original manager renders both record kinds',await a.locator('.sd-restore-storage-item').count()===2);
  check('no default selection or implicit loss consent',await a.locator('dialog input:checked').count()===0&&await a.locator('[data-restore-storage=clear]').isDisabled());
  check('manager explains browser-only recovery and no server deletion',await a.locator('dialog').evaluate(node=>node.textContent.includes('只在此浏览器')&&node.textContent.includes('不会删除服务器聊天或原图')));
  await historical(a).check();check('selection alone cannot dismiss',await a.locator('[data-restore-storage=clear]').isDisabled());
  await a.locator('[data-restore-loss]').check();check('separate loss consent enables explicit closure',await a.locator('[data-restore-storage=clear]').isEnabled());
  await a.evaluate(()=>view.close());check('closing without committing preserves exact record',await a.evaluate(async()=>JSON.stringify(await journal.loadHistoricalChatMutation(namespace))===JSON.stringify(record)));
  await a.reload();await setup(a);check('actual reload retains record and its full before/after payload',await a.evaluate(async()=>{window.record=await journal.loadHistoricalChatMutation(namespace);return record.proposal.after.characterDrafts.items[0].future.note.includes('original extension');}));
  await a.evaluate(()=>open());await idle(a);await historical(a).check();await a.locator('[data-restore-loss]').check();
  await a.evaluate(async()=>{record=await journal.updateHistoricalChatMutation(record,'submitted');});
  await a.locator('[data-restore-storage=clear]').click();await idle(a);
  check('stale UI selection cannot dismiss a newly advanced journal revision',await a.evaluate(async()=>(await journal.loadHistoricalChatMutation(namespace)).phase==='submitted'));
  check('stale closure reports change and resets both selection and consent',await a.locator('dialog').evaluate(node=>node.textContent.includes('已变化'))&&await a.locator('dialog input:checked').count()===0);
  await a.locator('[data-restore-storage=refresh]').click();await idle(a);
  check('submitted phase names pending chat confirmation instead of completed originals',await a.locator('dialog').evaluate(node=>node.textContent.includes('聊天保存已发起，待核对')&&!node.textContent.includes('原件已核对')));
  const sibling=await a.context().newPage();await sibling.goto(origin);
  await sibling.evaluate(ns=>new Promise(ready=>{navigator.locks.request('qianmu:package-import:'+ns,async()=>{ready();await new Promise(done=>window.releaseLock=done);});}),f.namespace);
  await historical(a).check();await a.locator('[data-restore-loss]').check();await a.locator('[data-restore-storage=clear]').click();await idle(a);
  check('real cross-page import lock refuses dismissal while another operation holds it',await a.locator('dialog').evaluate(node=>node.textContent.includes('另一页面'))&&await a.evaluate(async()=>Boolean(await journal.loadHistoricalChatMutation(namespace))));
  await sibling.evaluate(()=>releaseLock());await sibling.close();
  await a.evaluate(async()=>{record=await journal.updateHistoricalChatMutation(record,'verified');});
  await a.locator('[data-restore-storage=refresh]').click();await idle(a);
  check('verified means chat metadata verified, not complete original restoration',await a.locator('dialog').evaluate(node=>node.textContent.includes('聊天资料已核对；原件仍需检查')));
  for(const width of [375,1024]){await a.setViewportSize({width,height:820});check('existing dialog remains within viewport at '+width,await a.locator('dialog').evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&node.scrollWidth<=node.clientWidth+1;}));}
  const b=await device();check('another device has no local historical recovery record',await b.evaluate(async()=>await journal.loadHistoricalChatMutation(namespace)===null));
  await historical(a).check();await a.locator('[data-restore-loss]').check();await a.locator('[data-restore-storage=clear]').click();await idle(a);
  check('explicit manager action removes only the selected historical row',await a.evaluate(async()=>await journal.loadHistoricalChatMutation(namespace)===null&&Boolean(await journal.loadResource(namespace,'characters'))));
  check('remaining old record stays in the same list',await a.locator('.sd-restore-storage-item').count()===1&&await a.locator('dialog').evaluate(node=>node.textContent.includes('已结束 1 条记录')));
  check('ending record releases account pending gate without touching native files',await a.evaluate(async()=>await journal.hasMutation(namespace)===false)&&Buffer.compare(await fs.readFile(f.file),original)===0&&f.saves===0);
  check('fast gate permits imports only after explicit record closure and respects account guard',await a.evaluate(async()=>{if(await journal.assertNoHistoricalChatMutation(namespace)!==true)return false;try{await journal.assertNoHistoricalChatMutation(namespace,{isCurrent:()=>false});return false;}catch{return true;}}));
  await a.evaluate(async()=>{
    record=await journal.prepareHistoricalChatMutation(await makeRecord(proposal),{confirmed:true});
    await new Promise((resolve,reject)=>{const req=indexedDB.open('qianmu-storyboard-package-journal',7);req.onsuccess=()=>{const db=req.result,tx=db.transaction('historicalChatMutations','readwrite');tx.objectStore('historicalChatMutations').put({...record,proposalDigest:'f'.repeat(64)});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};req.onerror=()=>reject(req.error);});
  });
  await a.locator('[data-restore-storage=refresh]').click();await idle(a);
  check('corrupt record becomes unavailable, never a misleading empty success',await a.locator('dialog').evaluate(node=>node.textContent.includes('尚未完成盘点'))&&await a.locator('[data-restore-storage=clear]').isDisabled());
  check('corrupt pending row is retained for later investigation',await a.evaluate(async()=>await journal.hasMutation(namespace)));
  check('corrupt row still blocks unrelated imports through key-only gate',await a.evaluate(async()=>{try{await journal.assertNoHistoricalChatMutation(namespace);return false;}catch(error){return error.message.includes('原聊天恢复记录');}}));
  check('no raw proposal entered manager DOM after normal or corrupt reads',await a.locator('dialog').evaluate(node=>!node.textContent.match(/silver hair|original extension|PRIVATE_|storyboardImages/)));
  check('all short-lived workers released and no external/production requests',await a.evaluate(()=>workers.every(worker=>worker.wasTerminated))&&unexpected.length===0&&errors.length===0);
  console.log(JSON.stringify({checks,errors,unexpected,devices:contexts.length,storage:'real-IDB-and-Worker',productionWrites:false}));
}finally{for(const context of contexts)await context.close();await browser.close();await new Promise(done=>server.close(done));await f.close();}
