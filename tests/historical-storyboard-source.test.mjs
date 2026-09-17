import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {historicalSourceFixture} from './helpers/historical-source-fixture.mjs';
import {recipe} from './helpers/recipe-client-fixture.mjs';
import {createHistoricalRecipeArchiveClient} from '../qianmu-recipe-archive-client.js';
import {captureHistoricalStoryboardSource,HISTORICAL_STORYBOARD_SOURCE_LIMITS as LIMIT} from '../qianmu-historical-storyboard-source.js';
import {captureStoryboardChatEvidence} from '../qianmu-storyboard-chat-evidence.js';
const gate=()=>{let release;return {promise:new Promise(done=>release=done),release:value=>release(value)};};
const pause=()=>new Promise(done=>setTimeout(done,10));
const savedFiles=async f=>{const folder=path.join(f.user,'.qianmu-recipes-v1'),names=await fs.readdir(folder);return Promise.all(names.sort().map(async name=>[name,await fs.readFile(path.join(folder,name),'utf8')]));};

test('source capture joins exact saved drafts, body evidence, inline and server recipes without any writes or current host data',async t=>{
  const f=await historicalSourceFixture(t),file=await fs.readFile(f.file),archives=await savedFiles(f),result=await f.capture();t.after(()=>result.close());
  const {source}=result;assert.equal(source.schema,'qianmu.storyboard.historical-source.v1');assert.deepEqual(source.saved,f.saved);
  assert.deepEqual(source.chatEvidence,await captureStoryboardChatEvidence(f.messages,f.target.chatId));
  assert.deepEqual(source.recipes.map(row=>row.snapshot),[recipe('inline original'),recipe('server original')]);
  assert.deepEqual(source.recipes.map(row=>row.origin),['saved-inline','server-archive']);assert.equal(source.recipes[1].reference.id,f.rows[1].snapshotServerRef.id);
  assert.deepEqual(source.selection,{ids:['inline','server'],total:2});assert.equal(source.observed.header.kind,'jsonl-header');
  assert.ok(source.observed.file.bytes>source.observed.header.bytes);assert.equal(await result.verify(),true);
  assert.ok(Object.isFrozen(source.saved.characterDrafts.items[0].future));assert.throws(()=>{source.recipes[0].snapshot.prompt='changed';},TypeError);
  assert.deepEqual(await fs.readFile(f.file),file);assert.deepEqual(await savedFiles(f),archives);
  assert.ok(f.calls.every(row=>['/chat-gallery/state','/chat-gallery/evidence','/chat-gallery/recipe/read'].some(suffix=>row.url.endsWith(suffix))));
  assert.ok(f.calls.every(row=>row.cache==='no-store'&&row.redirect==='error'&&row.credentials==='same-origin'&&row.headers.Authorization===undefined));
  assert.doesNotMatch(JSON.stringify(source),/PRIVATE_HISTORY|PRIVATE_VOICE|PRIVATE_KEY|PRIVATE_HIDDEN|WRONG_GLOBAL/);
});

test('explicit selection is detached, stable in saved order and reads no unselected recipe',async t=>{
  const f=await historicalSourceFixture(t),ids=['server'],pending=f.capture({recordIds:ids});ids[0]='inline';
  const result=await pending;t.after(()=>result.close());assert.deepEqual(result.source.selection,{ids:['server'],total:2});
  assert.deepEqual(result.source.saved.storyboardImages,[f.rows[1]]);assert.deepEqual(result.source.saved.characterDrafts,f.saved.characterDrafts);
  assert.deepEqual(f.calls.filter(row=>row.url.endsWith('/recipe/read')).map(row=>row.body.selection.recordId),['server']);
  assert.equal(f.calls.filter(row=>row.url.endsWith('/recipe/preserve')).length,0);
});

test('history recipe client is read-only, detached from caller arrays, and binds exact server selectors',async t=>{
  const f=await historicalSourceFixture(t),rows=structuredClone(f.rows),record=structuredClone(rows[1]);
  const c=createHistoricalRecipeArchiveClient({...f.options(),records:rows});t.after(()=>c.close());assert.equal(c.preserve,undefined);
  rows[1].createdAt=99;rows[1].snapshotServerRef=null;const result=await c.read(record);assert.equal(result.snapshot.prompt,'server original');
  const sent=f.calls.at(-1);assert.equal(sent.body.selection.createdAt,2);assert.deepEqual(sent.body.target,{kind:'character',chatId:f.target.chatId,avatar:f.target.avatar});
  assert.deepEqual(Object.keys(sent.body).sort(),['expectedAccount','selection','target','version']);
  assert.deepEqual(sent.headers,{'Content-Type':'application/json',Accept:'application/json','X-CSRF-Token':'fixture'});
});

test('invalid selectors and missing guards fail before network; empty source allows resources without images',async t=>{
  const f=await historicalSourceFixture(t);
  for(const change of [{account:null},{guard:null},{gallerySha256:'invalid'},{namespace:'alice'},{target:{kind:'group',chatId:'../chat'}},{recordIds:['server','server']},{recordIds:new Array(2)},{maxBytes:LIMIT.bytes+1},{timeoutMs:NaN}])await assert.rejects(f.capture(change));
  assert.equal(f.calls.length,0);
  for(const recordIds of [[],['foreign']])await assert.rejects(f.capture({recordIds}));
  f.rows.splice(0);await f.write();const result=await f.capture({recordIds:[]});t.after(()=>result.close());assert.deepEqual(result.source.recipes,[]);assert.deepEqual(result.source.selection,{ids:[],total:0});
});

test('duplicate original IDs or over-400 default scope never pick arbitrary images',async t=>{
  const f=await historicalSourceFixture(t);f.rows.push({...f.rows[0]});await f.write();await assert.rejects(f.capture(),/编号无效或重复/);
  f.rows.splice(0,f.rows.length,...Array.from({length:401},(_,i)=>({id:'image'+i,createdAt:i,snapshot:{source:'comfy',prompt:'minimal',negative:'',profile:{},payload:{}}})));await f.write();
  await assert.rejects(f.capture(),/1 至 400/);assert.equal(f.calls.filter(row=>row.url.endsWith('/recipe/read')).length,0);
});

test('explicit unavailable, legacy-local-only and malformed recipes fail without guessing caches or defaults',async t=>{
  const f=await historicalSourceFixture(t),original=structuredClone(f.rows[0]);
  for(const patch of [{recipeUnavailable:true},{snapshot:null,snapshotRef:'old-device-key'},{snapshot:{}},{snapshot:null,snapshotServerRef:{id:'wrong'}}]){
    f.rows[0]={...original,...patch};await f.write();f.calls.length=0;await assert.rejects(f.capture({recordIds:['inline']}));assert.equal(f.calls.filter(row=>row.url.endsWith('/recipe/read')).length,0);
  }
  const result=await f.capture({recordIds:['server']});result.close();
});

test('missing or corrupt server originals prevent partial delivery and remain untouched',async t=>{
  for(const mode of ['missing','corrupt']){
    const f=await historicalSourceFixture(t),file=path.join(f.user,'.qianmu-recipes-v1',f.rows[1].snapshotServerRef.id+'.json');
    if(mode==='missing')await fs.rename(file,file+'.retained');else await fs.writeFile(file,'broken');
    const before=await savedFiles(f);await assert.rejects(f.capture());assert.deepEqual(await savedFiles(f),before);
  }
});

test('limits stop reading without handing out a partial source',async t=>{
  const f=await historicalSourceFixture(t);await assert.rejects(f.capture({maxBytes:1}),/读取上限/);assert.equal(f.calls.filter(row=>row.url.endsWith('/recipe/read')).length,0);
  const complete=await f.capture(),base={...complete.source,recipes:[]},maxBytes=new TextEncoder().encode(JSON.stringify(base)).byteLength+1;complete.close();f.calls.length=0;
  await assert.rejects(f.capture({maxBytes}),/配方合计/);assert.equal(f.calls.filter(row=>row.url.endsWith('/recipe/read')).length,1);
});

test('an altered inline reply cannot be substituted for the captured original even with matching selectors',async t=>{
  const f=await historicalSourceFixture(t);await assert.rejects(f.capture({fetchImpl:async(url,options)=>{
    const response=await f.fetch(url,options);if(url.endsWith('/recipe/read')&&JSON.parse(options.body).selection.recordId==='inline'){
      const value=await response.json();value.snapshot.prompt='fabricated';return Response.json(value);
    }return response;
  }}),/内联原件不符/);
});

test('file or draft changes between independently read components invalidate the final observation',async t=>{
  for(const mode of ['body','draft','gallery']){
    const f=await historicalSourceFixture(t);let changed=false;
    await assert.rejects(f.capture({fetchImpl:async(url,options)=>{
      const response=await f.fetch(url,options);if(!changed&&url.endsWith('/recipe/read')){changed=true;
        if(mode==='body')f.messages.push({mes:'late body'});else if(mode==='draft')f.saved.characterDrafts.items[0].future.note='late edit';else f.rows[0].createdAt=90;
        await f.write();}return response;
    }}));assert.equal(changed,true);
  }
});

test('explicit revalidation rejects subsequent body or metadata edits and permanently closes the stale session',async t=>{
  for(const mode of ['body','draft','header']){
    const f=await historicalSourceFixture(t),result=await f.capture();
    if(mode==='body')f.messages[0].mes='edited';else if(mode==='draft')f.saved.characterDrafts.items[0].future.note='edited';
    await f.write(mode==='header'?{bom:'\uFEFF'}:{});await assert.rejects(result.verify());const count=f.calls.length;await assert.rejects(result.verify());assert.equal(f.calls.length,count);
  }
});

test('revalidation catches metadata changed while body evidence is being read',async t=>{
  const f=await historicalSourceFixture(t);let armed=false;
  const result=await f.capture({fetchImpl:async(url,options)=>{const response=await f.fetch(url,options);
    if(armed&&url.endsWith('/evidence')){armed=false;f.saved.characterDrafts.items[0].future.note='during verify';await f.write();}return response;}});
  armed=true;await assert.rejects(result.verify(),/正文核对期间/);result.close();
});

test('account, outer guard and late response changes never publish or revalidate the old source',async t=>{
  for(const mode of ['account','guard']){
    const f=await historicalSourceFixture(t);let done=false;
    await assert.rejects(f.capture({fetchImpl:async(...args)=>{const response=await f.fetch(...args);if(!done){done=true;if(mode==='account')f.account='st-user:bob';else f.active=false;}return response;}}));
    assert.equal(f.calls.length,1);f.active=true;
  }
  const f=await historicalSourceFixture(t),result=await f.capture();f.account='st-user:bob';const count=f.calls.length;await assert.rejects(result.verify());assert.equal(f.calls.length,count);
});

test('whole-session deadlines cover unresolved caller guards and prevent late request chains',async t=>{
  const f=await historicalSourceFixture(t),waiting=gate();let calls=0;
  await assert.rejects(f.capture({timeoutMs:100,account:async()=>waiting.promise,fetchImpl:async(...args)=>{calls++;return f.fetch(...args);}}),/取消或超时/);
  waiting.release('st-user:alice');await pause();assert.equal(calls,0);
  let released=false;await assert.rejects(f.capture({timeoutMs:100,requestTimeoutMs:30000,fetchImpl:async()=>new Response(new ReadableStream({cancel(){released=true;}}),{headers:{'Content-Type':'application/json'}})}));assert.equal(released,true);
  const abort=new AbortController();abort.abort();const before=f.calls.length;await assert.rejects(f.capture({signal:abort.signal}));assert.equal(f.calls.length,before);
});

test('overall deadline spans individually valid requests and an old backend is not treated as an empty historical source',async t=>{
  const f=await historicalSourceFixture(t);
  await assert.rejects(f.capture({fetchImpl:async()=>new Response('old',{status:404})}),/更新千幕配套后端/);
  const entered=gate(),waiting=gate();let calls=0;
  const pending=assert.rejects(f.capture({timeoutMs:100,requestTimeoutMs:30000,fetchImpl:async(...args)=>{
    if(++calls===2){entered.release();await waiting.promise;}return f.fetch(...args);
  }}),/取消或超时/);
  await entered.promise;await pending;waiting.release();await pause();assert.equal(calls,2);
});

test('closing or cancelling verification releases readers; concurrent verification is refused without a second request chain',async t=>{
  const f=await historicalSourceFixture(t),blocked=gate(),entered=gate();let hold=false;
  const result=await f.capture({fetchImpl:async(...args)=>{if(hold){entered.release();await blocked.promise;}return f.fetch(...args);}});
  hold=true;const verifying=assert.rejects(result.verify());await entered.promise;await assert.rejects(result.verify(),/正在读取/);result.close();await verifying;
  const count=f.calls.length;blocked.release();await pause();assert.equal(f.calls.length,count+1); // Ignored fixture fetch may finish, but no next request is dispatched.
  await assert.rejects(result.verify());
  const other=await f.capture(),controller=new AbortController();controller.abort();const before=f.calls.length;await assert.rejects(other.verify({signal:controller.signal}));assert.equal(f.calls.length,before);other.close();
});

test('server archive workflow strings are checked for portable credentials after genuine readback',async t=>{
  const f=await historicalSourceFixture(t);f.rows[1].snapshot=recipe('unsafe workflow');f.rows[1].snapshot.payload.workflow='{"node":{"inputs":{"api_key":"SECRET"}}}';delete f.rows[1].snapshotServerRef;await f.write();
  const {gallerySha256,...body}=f.request(),receipt=await f.recipes.preserve(f.req,{...body,selection:{recordId:'server',createdAt:2,gallerySha256}});
  f.rows[1].snapshotServerRef=receipt.reference;delete f.rows[1].snapshot;await f.write();
  const before=await savedFiles(f);await assert.rejects(f.capture({recordIds:['server']}),/凭据/);assert.deepEqual(await savedFiles(f),before);
});
