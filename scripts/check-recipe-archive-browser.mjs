// Two disposable browser contexts + real temporary ST chat files. No live ST or provider traffic.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import http from 'node:http';
import {recipeClientFixture} from '../tests/helpers/recipe-client-fixture.mjs';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const f=await recipeClientFixture(),checks=[],errors=[],unexpected=[];
const config=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
const modules=new Map(await Promise.all(config.files.filter(file=>file.endsWith('.js')).map(async file=>['/'+file,await readFile(new URL('../'+file,import.meta.url),'utf8')])));
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const server=http.createServer(async(req,res)=>{
  try{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html><body></body></html>');return;}
    if(modules.has(path)){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(modules.get(path));return;}
    if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(path==='/fixture'){json(res,f.rows);return;}
    let body='';for await(const part of req){body+=part;if(body.length>3*1024*1024)throw Error('oversized fixture');}
    if(path==='/fixture-save'){f.rows=JSON.parse(body);await f.save();json(res,{ok:true});return;}
    if(/^\/api\/plugins\/qianmu-tts\/chat-gallery\/recipe\/(?:read|preserve|storage)$/.test(path)){
      const result=await f.fetch(path,{body,signal:new AbortController().signal});json(res,await result.json(),result.status);return;
    }
    unexpected.push(path);json(res,{ok:false},404);
  }catch(error){errors.push(error.message);json(res,{ok:false},500);}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const contexts=[];
const source=['storyboardRecordChatKey','storyboardSnapshotKey','storyboardSnapshotForRecord','storyboardRecipeArchiveClient','storyboardReadSnapshotForRecord',
  'storyboardStoreSnapshotForRecord','storyboardArchiveGallerySnapshots','storyboardHydrateGallerySnapshots'].map(section).join('\n');
async function device(){
  const context=await browser.newContext();contexts.push(context);
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){unexpected.push(route.request().url());return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
  await page.evaluate(async source=>{
    const rows=await (await fetch('/fixture')).json(),runtime=await import('/qianmu-recipe-archive-client.js');
    const context={chatId:'chat',characterId:0,characters:[{avatar:'Alice.png',chat:'chat'}],chat:[],chatMetadata:{story_director_liminale:{storyboardImages:rows}},getRequestHeaders:()=>({'X-CSRF-Token':'fixture-only'})};
    Object.assign(window,await import('/qianmu-plan-archive-write.js'),{rows,context,account:'st-user:alice',clone:structuredClone,sanitizeStoryboardSnapshot:structuredClone,
      blobStore:await import('/qianmu-blobstore.js'),storyboardSnapshotEpoch:0,storyboardSnapshotCache:new Map(),storyboardSnapshotReads:new Map(),
      ctx:()=>context,getChatKey:()=>context.chatId,storyboardGalleryRecords:()=>rows,storyboardPackageArchiveAllowed:async()=>true,toast:message=>{window.lastToast=message;},
      featureRuntime:{load:async()=>({createCurrentRecipeArchiveClient:options=>runtime.createCurrentRecipeArchiveClient({...options,account:async()=>window.account})})},
      saveMetadata:async()=>{const r=await fetch('/fixture-save',{method:'POST',body:JSON.stringify(rows)});if(!r.ok)throw Error('fixture save failed');}});
    window.entry=new Function(source+';return {archive:storyboardArchiveGallerySnapshots,read:storyboardReadSnapshotForRecord,store:storyboardStoreSnapshotForRecord,snapshot:storyboardSnapshotForRecord,hydrate:storyboardHydrateGallerySnapshots};')();
  },source);
  return page;
}
const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);};
try{
  const a=await device();const original=structuredClone(f.rows[0].snapshot);
  check('actual automatic archive succeeds with native IndexedDB and real server files',await a.evaluate(()=>entry.archive())===1);
  check('host metadata holds the durable server reference and no heavy inline copy',Boolean(f.rows[0].snapshotServerRef)&&!f.rows[0].snapshot);
  const originalRef=f.rows[0].snapshotServerRef;
  const b=await device();
  check('new device has no local recipe archives',(await b.evaluate(()=>blobStore.getStoryboardSnapshots([rows[0].snapshotRef]))).length===0);
  assert.deepEqual(await b.evaluate(()=>entry.read(rows[0])),original);checks.push('new device reads every original workflow node and unknown field from the saved reference');
  check('server-backed synchronous lookup does not borrow legacy cache',await b.evaluate(()=>{storyboardSnapshotCache.set(rows[0].snapshotRef,{prompt:'wrong device/account'});return entry.snapshot(rows[0])===null;}));
  check('hydration does not write server recipes into the old unscoped cache',await b.evaluate(()=>entry.hydrate(rows,{migrate:false}))===0);
  await b.evaluate(async()=>{const snapshot=await entry.read(rows[0]);snapshot.prompt='edited on second device';await entry.store(rows[0],snapshot);});
  check('editing clears old server ref and retains inline until host save',await b.evaluate(()=>!rows[0].snapshotServerRef&&rows[0].snapshot.prompt==='edited on second device'));
  await b.evaluate(()=>saveMetadata());check('edited inline is saved before publication',f.rows[0].snapshot.prompt==='edited on second device');
  check('edit archive finishes without generation',await b.evaluate(()=>entry.archive([rows[0]]))===1);
  check('edited recipe has its own immutable server reference',f.rows[0].snapshotServerRef.id!==originalRef.id);
  const savedOriginal=JSON.parse(await readFile(f.archive+'/'+originalRef.id+'.json','utf8'));
  assert.deepEqual(savedOriginal.snapshot,original);checks.push('old server recipe remains byte-content intact after another-device edit');
  const c=await device();check('third fresh device sees saved edit',(await c.evaluate(()=>entry.read(rows[0]))).prompt==='edited on second device');
  check('account mismatch rejects read instead of cache/current-settings fallback',await c.evaluate(async()=>{account='st-user:bob';try{await entry.read(rows[0]);return false;}catch{return Boolean(lastToast);}}));
  await c.evaluate(()=>{account='st-user:alice';});
  check('failed metadata save retains inline and clears unpublished ref',await c.evaluate(async()=>{
    rows[0].snapshot={...await entry.read(rows[0]),prompt:'retry after failed host save'};delete rows[0].snapshotServerRef;await saveMetadata();
    window.realSave=saveMetadata;window.saveMetadata=async()=>{throw Error('synthetic save failure');};
    const result=await entry.archive();window.saveMetadata=realSave;
    return result===0&&rows[0].snapshot.prompt==='retry after failed host save'&&!rows[0].snapshotServerRef;
  }));
  check('retry safely publishes the already preserved recipe',await c.evaluate(()=>entry.archive())===1);
  check('closed sessions refuse late reads',await c.evaluate(async()=>{const module=await import('/qianmu-recipe-archive-client.js'),client=module.createCurrentRecipeArchiveClient({getContext:ctx,epoch:()=>0,getGallery:storyboardGalleryRecords,account:async()=>account});client.close();try{await client.read(rows[0]);return false;}catch{return true;}}));
  const usage=await c.evaluate(async()=>{context.chatId=undefined;const {collectRecipeArchiveStorage}=await import('/qianmu-recipe-storage.js');return collectRecipeArchiveStorage({resolveNamespace:async()=>account,headers:()=>context.getRequestHeaders()});});
  check('server file observation works without an open chat and includes retained versions',usage.status==='ready'&&usage.files===3&&usage.bytes>originalRef.bytes);
  check('a fresh browser context sees the same account-level server observation',JSON.stringify(await b.evaluate(async()=>{const {collectRecipeArchiveStorage}=await import('/qianmu-recipe-storage.js');return collectRecipeArchiveStorage({resolveNamespace:async()=>account});}))===JSON.stringify(usage));
  check('browser rejects a pending observation after account switch',await c.evaluate(async()=>{
    const {collectRecipeArchiveStorage}=await import('/qianmu-recipe-storage.js');try{await collectRecipeArchiveStorage({resolveNamespace:async()=>account,fetchImpl:async(...args)=>{const reply=await fetch(...args);account='st-user:bob';return reply;}});return false;}catch(error){return error.code==='recipe_storage_stale';}finally{account='st-user:alice';}
  }));
  check('old backend keeps unknown server bytes distinct from zero in the browser',await c.evaluate(async()=>{
    const {collectRecipeArchiveStorage}=await import('/qianmu-recipe-storage.js');const value=await collectRecipeArchiveStorage({resolveNamespace:async()=>account,fetchImpl:async()=>new Response('old',{status:404})});return value.status==='unavailable'&&value.bytes===null&&value.files===null;
  }));
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  check('no paid generation or external routes were called',f.calls.every(call=>/\/recipe\/(?:read|preserve|storage)$/.test(call.url)));
  console.log(JSON.stringify({checks,errors,unexpected,isolatedDevices:contexts.length,realTemporaryChatFiles:true}));
}finally{for(const context of contexts)await context.close();await browser.close();await new Promise(done=>server.close(done));await f.close();}
