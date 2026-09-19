import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {imageServiceAccount} from '../qianmu-image-service-access.js';
import {createTextCollection} from '../qianmu-text-collection.js';
import {createTextCollectionSyncService} from '../qianmu-text-collection-sync-service.js';
import {TEXT_COLLECTION_SYNC_LIMITS} from '../qianmu-text-collection-sync-contract.js';
import {textCollectionSyncResponse,textCollectionSyncErrorPayload} from '../qianmu-text-collection-sync-contract.js';
import {init,exit} from '../server-plugin.js';
import {createServer} from 'node:http';
import {createTextCollectionClient} from '../qianmu-text-collection-client.js';

const account=handle=>imageServiceAccount({user:{profile:{handle}}}).namespace;
const request=(folder,handle='alice')=>({user:{profile:{handle},directories:{root:folder}}});
const query=(extra={})=>({version:1,expectedAccount:account('alice'),cursor:null,limit:50,...extra});
const detail=(id='collection-1')=>({version:1,expectedAccount:account('alice'),id});
const create=(id='collection-1',handle='alice',createdAt=1)=>({version:1,expectedAccount:account(handle),mutationId:randomUUID(),operation:'create',id,baseRevision:0,
  record:createTextCollection({id,mode:'selection',source:{account:account(handle),chatId:'deleted-chat',messageId:0,replyId:'reply-1',charName:'角色',userName:'读者',text:'hidden START selected😀 END hidden'},start:13,end:23,createdAt})});
const edit=(operation='edit',extra={})=>({version:1,expectedAccount:account('alice'),mutationId:randomUUID(),operation,id:'collection-1',baseRevision:1,...operation==='edit'?{text:' edited\r\ntext '}:{},...extra});
async function fixture(t,options={}){
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-collection-test-')),folder=path.join(root,'alice');await fs.mkdir(folder);
  const services=[],build=extra=>{const service=createTextCollectionSyncService({dataRoot:root,now:()=>100,...options,...extra});services.push(service);return service;};
  const service=build(),req=request(folder);
  t.after(async()=>{await Promise.all(services.map(s=>s.close()));const real=await fs.realpath(root);assert.equal(path.dirname(real),parent);assert.match(path.basename(real),/^qianmu-collection-test-/);await fs.rm(real,{recursive:true});});
  return {root,folder,req,service,build,file:path.join(folder,'.qianmu-text-collection-v1.json'),lock:path.join(folder,'.qianmu-text-collection-v1.lock')};
}
const gate=()=>{let release;return {promise:new Promise(resolve=>{release=resolve;}),release:()=>release()};};

test('reads create no files, host identity fences all operations and client paths are rejected',async t=>{
  const f=await fixture(t);assert.deepEqual((await f.service.list(f.req,query())).items,[]);assert.deepEqual(await fs.readdir(f.folder),[]);
  await assert.rejects(f.service.list({},query()),{status:401});await assert.rejects(f.service.write(f.req,create('collection-1','bob')),{status:401});
  await assert.rejects(f.service.list(f.req,query({path:f.folder})),{status:400});
  await assert.rejects(f.service.get(request(f.root),detail()),{status:403});
});
test('originals survive service restart and source-chat absence; accounts and notes stay independent',async t=>{
  const f=await fixture(t),input=create(),saved=await f.service.write(f.req,input);assert.equal(saved.revision,1);
  const reopened=f.build();assert.deepEqual((await reopened.get(f.req,detail())).record,input.record);
  const serialized=await fs.readFile(f.file,'utf8');assert.doesNotMatch(serialized,/hidden START|END hidden/);
  assert.deepEqual(await fs.readdir(f.folder),['.qianmu-text-collection-v1.json']);
  const bobFolder=path.join(f.root,'bob');await fs.mkdir(bobFolder);const bob=request(bobFolder,'bob');
  assert.deepEqual((await reopened.list(bob,query({expectedAccount:account('bob')}))).items,[]);
  await reopened.write(bob,create('collection-1','bob'));assert.equal((await reopened.list(f.req,query())).total,1);
});
test('same mutation is durable across restart, later edits and deletion without retaining old text',async t=>{
  const f=await fixture(t),first=create(),ack=await f.service.write(f.req,first),update=edit();
  const updated=await f.service.write(f.req,update);assert.equal(updated.revision,2);
  const before=await fs.readFile(f.file);assert.deepEqual(await f.build().write(f.req,first),ack);assert.deepEqual(await fs.readFile(f.file),before);
  await assert.rejects(f.service.write(f.req,{...update,text:'different'}),{code:'text_collection_sync_mutation_conflict'});
  const removed=await f.service.write(f.req,edit('delete',{baseRevision:2}));assert.equal(removed.revision,3);
  assert.deepEqual(await f.service.write(f.req,first),ack);assert.equal((await f.service.get(f.req,detail())).record,null);
  assert.doesNotMatch(await fs.readFile(f.file,'utf8'),/selected|edited|deleted-chat|角色|读者/);
  await assert.rejects(f.service.write(f.req,create()),{code:'text_collection_sync_conflict'});
});
test('per-record CAS does not block edits to different entries and summaries use snapshot names plus bounded previews',async t=>{
  const f=await fixture(t);await f.service.write(f.req,create());await f.service.write(f.req,create('collection-2','alice',2));
  await f.service.write(f.req,edit());await assert.rejects(f.service.write(f.req,edit()),{code:'text_collection_sync_conflict'});
  const page=await f.service.list(f.req,query({limit:1}));assert.equal(page.items[0].id,'collection-2');assert.equal(page.items[0].charName,'角色');
  assert.equal('text' in page.items[0],false);assert.equal('source' in page.items[0],false);
  const last=await f.service.list(f.req,query({limit:1,cursor:page.nextCursor}));assert.equal(last.items[0].id,'collection-1');assert.equal(last.nextCursor,null);
  await f.service.write(f.req,edit('edit',{id:'collection-2',text:'second entry'}));
  await assert.rejects(f.service.list(f.req,query({cursor:page.nextCursor})),{code:'text_collection_sync_changed'});
  await assert.rejects(f.service.list(f.req,query({limit:51})),{status:400});
});
test('corrupt files and valid-checksum broken receipts are retained, never replaced as empty collections',async t=>{
  const f=await fixture(t);await f.service.write(f.req,create());const original=await fs.readFile(f.file,'utf8');
  for(const mutate of [state=>{state.entries[0].record.source.account=account('bob');},state=>{state.mutations[0].revision=2;},state=>{state.entries[0].record.apiKey='secret';},state=>{state.entries=[];}]){
    const {checksum,...state}=JSON.parse(original);mutate(state);const data=JSON.stringify({...state,checksum:createHash('sha256').update(JSON.stringify(state)).digest('hex')});await fs.writeFile(f.file,data);
    await assert.rejects(f.service.list(f.req,query()),{status:503});await assert.rejects(f.service.write(f.req,create('collection-2')));assert.equal(await fs.readFile(f.file,'utf8'),data);
  }
  await fs.writeFile(f.file,'broken');await assert.rejects(f.service.list(f.req,query()),{status:503});assert.equal(await fs.readFile(f.file,'utf8'),'broken');
});
test('failure before rename preserves the original; lost acknowledgement retries without duplicate revisions',async t=>{
  const f=await fixture(t);await f.service.write(f.req,create());const original=await fs.readFile(f.file),input=edit();
  const failed=f.build({io:{...fs,rename:async()=>{throw Error('private disk path');}}});
  await assert.rejects(failed.write(f.req,input),cause=>cause.writeState==='unconfirmed'&&!cause.message.includes('private disk'));assert.deepEqual(await fs.readFile(f.file),original);
  let lose=true;const uncertain=f.build({io:{...fs,rename:async(...args)=>{await fs.rename(...args);if(lose){lose=false;throw Error('lost ack');}}}});
  await assert.rejects(uncertain.write(f.req,input),{writeState:'unconfirmed'});
  const ack=await f.service.write(f.req,input);assert.equal(ack.revision,2);assert.equal(ack.libraryRevision,2);assert.equal((await f.service.list(f.req,query())).total,1);
});
test('same-service writers serialize while a second service cannot take an occupied lock',async t=>{
  const f=await fixture(t),held=gate(),entered=gate();let hold=true;
  const slow=f.build({io:{...fs,open:async(file,...args)=>{const handle=await fs.open(file,...args);if(hold&&file===f.lock){hold=false;entered.release();await held.promise;}return handle;}}});
  const pending=slow.write(f.req,create());await entered.promise;
  await assert.rejects(f.service.write(f.req,create()),{code:'text_collection_sync_busy'});held.release();await pending;
  const outcomes=await Promise.allSettled([slow.write(f.req,edit()),slow.write(f.req,edit())]);
  assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);assert.equal(outcomes.find(row=>row.status==='rejected').reason.code,'text_collection_sync_conflict');
});
test('account switch, abort and close suppress queued work; links never redirect originals',async t=>{
  for(const action of ['account','abort','close']){
    const f=await fixture(t),held=gate(),entered=gate();let hold=true;const controller=new AbortController();
    const slow=f.build({io:{...fs,realpath:async(...args)=>{const result=await fs.realpath(...args);if(hold){hold=false;entered.release();await held.promise;}return result;}}});
    const pending=slow.write(f.req,create(),{signal:controller.signal});await entered.promise;let closing;
    if(action==='account')f.req.user.profile.handle='bob';if(action==='abort')controller.abort();if(action==='close')closing=slow.close();held.release();await assert.rejects(pending);await closing;
    assert.deepEqual(await fs.readdir(f.folder),[]);
  }
  const f=await fixture(t);await f.service.write(f.req,create());const original=await fs.readFile(f.file),link=path.join(f.root,'linked');await fs.link(f.file,link);
  await assert.rejects(f.service.get(f.req,detail()),{code:'text_collection_sync_corrupt'});assert.deepEqual(await fs.readFile(link),original);
});

test('capacity limits refuse new mutations without evicting originals, tombstones or receipts',async t=>{
  const f=await fixture(t);await f.service.write(f.req,create());const original=JSON.parse(await fs.readFile(f.file,'utf8'));
  for(const mode of ['records','mutations']){
    const {checksum,...state}=structuredClone(original),count=TEXT_COLLECTION_SYNC_LIMITS[mode];
    state.revision=count;
    state.mutations=Array.from({length:count},(_,i)=>({mutationId:`mutation-${i}`,hash:'a'.repeat(64),id:mode==='records'?`collection-${i}`:'collection-1',revision:mode==='records'?1:i+1,updatedAt:i+1,operation:mode==='records'||i===0?'create':'edit'}));
    const base=state.entries[0];state.entries=mode==='records'?Array.from({length:count},(_,i)=>({...base,id:`collection-${i}`,updatedAt:i+1,record:{...base.record,id:`collection-${i}`,updatedAt:i+1}})):
      [{...base,revision:count,updatedAt:count,record:{...base.record,revision:count,updatedAt:count}}];
    const data=JSON.stringify({...state,checksum:createHash('sha256').update(JSON.stringify(state)).digest('hex')});await fs.writeFile(f.file,data);
    await assert.rejects(f.service.write(f.req,create('one-more-id')),{code:'text_collection_sync_capacity',status:507});assert.equal(await fs.readFile(f.file,'utf8'),data);
  }
});
test('an account change during post-commit lock release never returns another account save acknowledgement',async t=>{
  const f=await fixture(t),service=f.build({io:{...fs,unlink:async file=>{await fs.unlink(file);if(file===f.lock)f.req.user.profile.handle='bob';}}});
  await assert.rejects(service.write(f.req,create()),{code:'text_collection_sync_account',status:401,writeState:'unconfirmed'});
  f.req.user.profile.handle='alice';assert.equal((await f.service.list(f.req,query())).total,1);
});

test('actual plugin routes authenticate and return only no-store collection results; service exits cleanly',async t=>{
  const f=await fixture(t),routes=new Map(),router={get:(p,h)=>routes.set(`GET ${p}`,h),post:(p,h)=>routes.set(`POST ${p}`,h)};
  await init(router,{dataRoot:f.root});t.after(exit);
  const call=async(action,req)=>{
    const result={status:200,headers:{}};const res={set(k,v){result.headers[k]=v;return res;},status(v){result.status=v;return res;},json(v){result.body=v;return res;},once(){},off(){}};
    await routes.get(`POST /text-collections/${action}`)(req,res);return result;
  };
  assert.equal((await call('list',{body:query()})).status,401);assert.deepEqual(await fs.readdir(f.folder),[]);
  const input=create(),written=await call('write',{...f.req,body:input});assert.equal(written.status,200);
  assert.deepEqual(textCollectionSyncResponse(written.body,'write',input),written.body);
  const listed=await call('list',{...f.req,body:query()});assert.equal(listed.headers['Cache-Control'],'no-store');assert.equal(listed.headers['X-Content-Type-Options'],'nosniff');
  assert.equal(textCollectionSyncResponse(listed.body,'list',query()).items.length,1);
  const found=await call('get',{...f.req,body:detail()});assert.deepEqual(textCollectionSyncResponse(found.body,'get',detail()).record,input.record);
  const foreign=await call('get',{...f.req,body:{...detail(),expectedAccount:account('bob')}});assert.equal(foreign.status,401);assert.doesNotMatch(JSON.stringify(foreign.body),/selected|deleted-chat/);
  const wrong=await call('write',{...f.req,body:{...input,mutationId:randomUUID()}});assert.equal(wrong.status,409);assert.equal(wrong.body.writeState,'not_started');
  await exit();assert.equal((await call('get',{...f.req,body:detail()})).status,409);
});

test('response validation refuses stale acknowledgements, wrong accounts, partial pages and hidden source text',async t=>{
  const f=await fixture(t),input=create(),ack=await f.service.write(f.req,input);
  for(const change of [{mutationId:randomUUID()},{id:'different-id'},{revision:2},{libraryRevision:0},{expectedAccount:account('bob')},{path:'private'}])assert.throws(()=>textCollectionSyncResponse({...ack,...change},'write',input));
  await f.service.write(f.req,create('collection-2','alice',2));const request=query({limit:1}),page=await f.service.list(f.req,request);
  assert.equal(textCollectionSyncResponse(page,'list',request).items[0].id,'collection-2');
  for(const mutate of [r=>{r.nextCursor=null;},r=>{r.nextCursor.offset=0;},r=>{r.items=[];},r=>{r.total=0;},r=>{r.items[0].text='hidden prose';},r=>{r.items[0].preview='x'.repeat(102);}]){
    const value=structuredClone(page);mutate(value);assert.throws(()=>textCollectionSyncResponse(value,'list',request));
  }
  const found=await f.service.get(f.req,detail());assert.throws(()=>textCollectionSyncResponse(found,'get',{...detail(),id:'another-id'}));
  assert.deepEqual(textCollectionSyncResponse({...found,record:null},'get',detail()).record,null);
  const payload=textCollectionSyncErrorPayload(Error('private path and credential'));assert.equal(payload.status,503);assert.doesNotMatch(JSON.stringify(payload),/private path|credential/);
});

test('real client and local HTTP plugin handlers round-trip disk originals without a live ST account',async t=>{
  const f=await fixture(t),routes=new Map(),router={get:(p,h)=>routes.set(`GET ${p}`,h),post:(p,h)=>routes.set(`POST ${p}`,h)};
  await init(router,{dataRoot:f.root});t.after(exit);let received=0;
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers['x-csrf-token'],'fixture-csrf');assert.equal(req.headers.authorization,undefined);received++;
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      req.user=f.req.user;req.body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.set=(k,v)=>{res.setHeader(k,v);return res;};res.status=n=>{res.statusCode=n;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return res;};
      const handler=routes.get(`${req.method} ${req.url.replace('/api/plugins/qianmu-tts','')}`);assert.equal(typeof handler,'function');await handler(req,res);
    }catch{res.statusCode=500;res.end('{}');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const c=createTextCollectionClient({expectedAccount:account('alice'),guard:()=>true,headers:()=>({'x-csrf-token':'fixture-csrf',Authorization:'never forward'}),
    fetchImpl:(url,options)=>fetch(new URL(url,origin),options)});t.after(()=>c.close());
  assert.equal((await c.list()).total,0);const input=create();assert.equal((await c.write(input)).revision,1);
  assert.deepEqual((await c.get(input.id)).record,input.record);assert.equal((await c.list()).items[0].charName,'角色');
  assert.equal((await c.write(edit())).revision,2);await assert.rejects(c.write(edit()),{code:'text_collection_sync_conflict'});
  assert.equal((await c.write(edit('delete',{baseRevision:2}))).revision,3);assert.equal((await c.get(input.id)).record,null);assert.equal((await c.list()).total,0);
  assert.equal(received,9);assert.doesNotMatch(await fs.readFile(f.file,'utf8'),/selected|edited|角色/);
});
