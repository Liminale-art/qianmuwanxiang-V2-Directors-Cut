import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createNativeTextCollectionClient} from '../qianmu-text-collection-native.js';
import {createStAccountStorage} from '../qianmu-st-account-storage.js';
import {createTextCollection} from '../qianmu-text-collection.js';

const namespace='st-user:read-performance',account='st-user:'+createHash('sha256').update(namespace.slice(8)).digest('hex');
const response=(value,status=200)=>new Response(typeof value==='string'?value:JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture({latency=false}={}){
  const files=new Map();let owner=namespace,live=true,clock=100,identity=0,get=0,post=0,onRequest=null;
  const resolveNamespace=async()=>{identity++;if(latency)await pause(2);return owner;};
  const config={resolveNamespace,isCurrent:()=>live,headers:()=>({}),origin:'https://st.fixture.invalid',fetchImpl:async(url,request)=>{
    if(latency)await pause(10);const path=new URL(url).pathname;await onRequest?.(path,request);
    if(request.method==='POST'){post++;assert.equal(path,'/api/files/upload');const {name,data}=JSON.parse(request.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));return response({path:`user/files/${name}`});}
    get++;const name=path.split('/').at(-1);return files.has(name)?response(files.get(name)):response({},404);
  }};
  const record=createTextCollection({id:'collection-perf1',mode:'full',createdAt:10,source:{account,chatId:'synthetic-chat',messageId:0,replyId:'synthetic-reply',charName:'角色',userName:'用户',text:'一条收藏原文'}});
  const seed=await createStAccountStorage(config);
  await seed.write('collections',{version:1,expectedAccount:account,revision:1,entries:[{id:record.id,revision:1,updatedAt:record.updatedAt,deleted:false,record}],receipts:[]},{expectedFingerprint:null});seed.close();
  const guard=async()=>{if(!live||await resolveNamespace()!==namespace||!live)throw Error('account changed');return true;};
  const make=(options={})=>createNativeTextCollectionClient({expectedAccount:account,guard,isCurrent:()=>live,storageFactory:options=>createStAccountStorage({...config,...options}),legacyFactory:()=>({snapshot:()=>assert.fail('existing native file must not read the legacy service'),close(){}}),now:()=>clock,...options});
  identity=get=post=0;
  return {make,record,config,files,counts:()=>({identity,get,post}),reset(){identity=get=post=0;},setAccount(value){owner=value;},setCurrent(value){live=value;},setRequestHook(value){onRequest=value;},advance(value){clock+=value;}};
}

test('synthetic latency quantifies a one-record list followed by its detail',async t=>{
  const f=await fixture({latency:true}),client=f.make(),start=performance.now();
  assert.equal((await client.list()).total,1);const listMs=performance.now()-start,list=f.counts();f.reset();
  const detailStart=performance.now();assert.equal((await client.get(f.record.id)).record.text,f.record.text);const detailMs=performance.now()-detailStart,detail=f.counts();
  t.diagnostic(JSON.stringify({list,detail,listMs:Math.round(listMs),detailMs:Math.round(detailMs),latency:'10ms per file request + 2ms per account resolver, synthetic only'}));
  assert.deepEqual(list,{identity:19,get:2,post:0});assert.deepEqual(detail,{identity:1,get:0,post:0});
  // Before this optimization: 72 identity resolutions + 4 GETs for list, then
  // 35 resolutions + 2 GETs for detail (measured with the same fixture).
  // Timings are diagnostic only: event-loop scheduling differs across hosts.
  assert.ok(list.identity+detail.identity<107/4);assert.equal(list.get+detail.get,2);client.close();
});

test('same-session list, detail and search reuse a bounded snapshot without exposing mutable originals',async()=>{
  const f=await fixture(),client=f.make();await client.list();f.reset();
  const detail=await client.get(f.record.id);assert.throws(()=>{detail.record.source.charName='污染缓存';},TypeError);
  assert.equal((await client.list({cursor:null,limit:50,search:'原文'})).total,1);
  assert.equal((await client.list({cursor:null,limit:50,search:'没有'})).total,0);
  assert.equal((await client.get(f.record.id)).record.source.charName,'角色');assert.equal(f.counts().get,0);client.close();
});

const edit=(record,baseRevision,text,mutationId)=>({version:1,expectedAccount:account,mutationId,operation:'edit',id:record.id,baseRevision,text});
test('explicit refresh, expiry and a new session discover remote changes while local writes publish only verified state',async()=>{
  const f=await fixture(),a=f.make(),b=f.make();await a.list();await b.list();
  await b.write(edit(f.record,1,'远端新正文','mutation-remote1'));f.reset();
  assert.equal((await a.get(f.record.id)).record.text,f.record.text);assert.equal(f.counts().get,0);
  a.invalidateReadCache();assert.equal((await a.get(f.record.id)).record.text,'远端新正文');assert.equal(f.counts().get,2);
  await b.write(edit(f.record,2,'远端再修改','mutation-remote2'));f.reset();
  assert.equal((await a.get(f.record.id,{forceRefresh:true})).record.text,'远端再修改');assert.equal(f.counts().get,2);
  await b.write(edit(f.record,3,'过期之后','mutation-remote3'));f.advance(15000);f.reset();
  assert.equal((await a.get(f.record.id)).record.text,'过期之后');assert.equal(f.counts().get,2);
  await a.write(edit(f.record,4,'本地已确认修改','mutation-local01'));f.reset();
  assert.equal((await a.get(f.record.id)).record.text,'本地已确认修改');assert.equal(f.counts().get,0);
  a.close();const reopened=f.make();assert.equal((await reopened.get(f.record.id)).record.text,'本地已确认修改');assert.equal(f.counts().get,2);
  reopened.close();b.close();
});

test('stale snapshot never rebases a write or deletion and failure invalidates the previous read snapshot',async()=>{
  const f=await fixture(),a=f.make(),b=f.make();await a.list();await b.list();
  await b.write(edit(f.record,1,'另一端修改','mutation-remote1'));f.reset();
  await assert.rejects(a.write(edit(f.record,1,'不可覆盖','mutation-stale01')),{code:'text_collection_sync_conflict'});
  assert.equal(f.counts().post,0);assert.equal(f.counts().get,2);f.reset();
  assert.equal((await a.get(f.record.id)).record.text,'另一端修改');assert.equal(f.counts().get,2);
  await a.write({version:1,expectedAccount:account,mutationId:'mutation-delete1',operation:'delete',id:f.record.id,baseRevision:2});f.reset();
  assert.equal((await a.get(f.record.id)).record,null);assert.equal((await a.list()).total,0);assert.equal(f.counts().get,0);
  a.close();b.close();
});

test('cached reads remain account-guarded, cancellable, bounded to their owner session and never substitute for failed refresh',async()=>{
  const f=await fixture(),client=f.make();await client.list();f.reset();
  f.setAccount('st-user:other');await assert.rejects(client.get(f.record.id));assert.equal(f.counts().get,0);
  f.setAccount(namespace);const controller=new AbortController();controller.abort();await assert.rejects(client.get(f.record.id,{signal:controller.signal}),{code:'text_collection_sync_cancelled'});assert.equal(f.counts().get,0);
  f.files.clear();await assert.rejects(client.get(f.record.id,{forceRefresh:true}),{code:'text_collection_sync_missing'});
  await assert.rejects(client.get(f.record.id),{code:'text_collection_sync_missing'});
  client.close();await assert.rejects(client.get(f.record.id));
});

test('inventory, backup and cleanup inspect the remote document, not a prior browsing snapshot',async()=>{
  const f=await fixture(),a=f.make(),b=f.make();await a.list();await b.write(edit(f.record,1,'用于核对的新正文','mutation-remote1'));f.reset();
  assert.equal((await a.snapshot()).backup.records[0].text,'用于核对的新正文');assert.equal(f.counts().get,2);f.reset();
  await a.inventory();assert.equal(f.counts().get,2);f.reset();await a.cleanupPlan();assert.equal(f.counts().get,2);
  a.close();b.close();
});

test('lifecycle-only nested guard still delegates transport-time account fencing to native storage',async()=>{
  for(const mode of ['read','write']){
    const f=await fixture(),client=f.make();await client.list();f.reset();
    f.setRequestHook(()=>{f.setAccount('st-user:switched-during-fetch');});
    const pending=mode==='read'?client.get(f.record.id,{forceRefresh:true}):client.write(edit(f.record,1,'不应提交','mutation-scope01'));
    await assert.rejects(pending,{code:'st_account_storage_account'});
    assert.equal(f.counts().post,0);client.close();
  }
});

test('verified browsing state survives panel close, with zero file reads on warm list/detail/search',async()=>{
  const f=await fixture(),readScope={},first=f.make({readScope});await first.list();first.close();f.reset();
  const reopened=f.make({readScope});assert.equal((await reopened.list({cursor:null,limit:50},{preferCache:true})).total,1);
  assert.equal((await reopened.get(f.record.id,{preferCache:true})).record.text,f.record.text);
  assert.equal((await reopened.list({cursor:null,limit:50,search:'原文'},{preferCache:true})).total,1);
  assert.equal(f.counts().get,0);assert.equal(f.counts().post,0);assert.equal(reopened.readCacheNeedsRefresh(),false);reopened.close();
});

test('unchanged background and reopened-session revalidation use one head GET, but a changed head reloads the body',async()=>{
  const f=await fixture(),readScope={},a=f.make({readScope});await a.list();f.reset();
  assert.equal((await a.list({cursor:null,limit:50},{revalidate:true})).total,1);
  assert.equal(f.counts().get,1,'same open session checks only the head');a.close();f.reset();
  const reopened=f.make({readScope});assert.equal((await reopened.list({cursor:null,limit:50},{revalidate:true})).total,1);
  assert.equal(f.counts().get,1,'a new panel also checks only the head of its verified snapshot');
  const remote=f.make();await remote.write(edit(f.record,1,'远端变更','mutation-head01'));remote.close();f.reset();
  const updated=await reopened.list({cursor:null,limit:50},{revalidate:true});
  assert.equal(updated.items[0].preview,'远端变更');assert.equal(f.counts().get,3,'changed head is followed by a verified head and body');reopened.close();
});

test('stale-first browsing stays usable while a background refresh is waiting, then sees the remote result',async()=>{
  const f=await fixture(),readScope={},first=f.make({readScope});await first.list();first.close();
  const remote=f.make();await remote.write(edit(f.record,1,'另一端最新正文','mutation-remote01'));remote.close();f.advance(60000);f.reset();
  const current=f.make({readScope});assert.equal((await current.get(f.record.id,{preferCache:true})).record.text,f.record.text);assert.equal(f.counts().get,0);assert.equal(current.readCacheNeedsRefresh(),true);
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});let hold=true;
  f.setRequestHook(async()=>{if(hold){hold=false;entered();await gate;}});
  const refreshing=current.list({cursor:null,limit:50},{revalidate:true});await started;
  assert.equal((await current.get(f.record.id,{preferCache:true})).record.text,f.record.text,'background refresh must not evict the visible cached body');
  release();await refreshing;assert.equal((await current.get(f.record.id,{preferCache:true})).record.text,'另一端最新正文');assert.equal(current.readCacheNeedsRefresh(),false);current.close();
});

test('shared read state publishes confirmed mutations, invalidates failures and never bypasses account guards',async()=>{
  const f=await fixture(),readScope={},a=f.make({readScope}),b=f.make({readScope});await a.list();await b.list();
  await b.write(edit(f.record,1,'已确认修改','mutation-shared01'));f.reset();assert.equal((await a.get(f.record.id,{preferCache:true})).record.text,'已确认修改');assert.equal(f.counts().get,0);
  f.setAccount('st-user:someone-else');await assert.rejects(a.get(f.record.id,{preferCache:true}));f.setAccount(namespace);f.reset();
  await b.get(f.record.id,{preferCache:true});assert.equal(f.counts().get,2,'an identity failure invalidates the shared snapshot');
  b.invalidateReadCache();f.reset();await a.list();assert.equal(f.counts().get,2);a.close();b.close();
});

test('new storage lifetime never reuses an earlier configuration snapshot',async()=>{
  const f=await fixture(),a=f.make({readScope:{}});await a.list();a.close();f.reset();
  const b=f.make({readScope:{}});await b.list({cursor:null,limit:50},{preferCache:true});assert.equal(f.counts().get,2);b.close();
});

test('authentication rejection revokes shared cached clients, while ordinary offline errors retain a readable snapshot',async()=>{
  for(const code of ['st_account_storage_account','st_account_storage_unavailable']){
    const f=await fixture(),readScope={},a=f.make({readScope}),b=f.make({readScope});await a.list();await b.list();
    f.setRequestHook(()=>{throw Object.assign(Error('synthetic failure'),{code});});
    await assert.rejects(a.list({cursor:null,limit:50},{revalidate:true}),{code});
    if(code==='st_account_storage_account'){
      await assert.rejects(a.get(f.record.id,{preferCache:true}),{code:'text_collection_sync_account'});
      await assert.rejects(b.get(f.record.id,{preferCache:true}),{code:'text_collection_sync_account'});
      f.setRequestHook(null);f.reset();const fresh=f.make({readScope});await fresh.list();assert.equal(f.counts().get,2);fresh.close();
    }else assert.equal((await b.get(f.record.id,{preferCache:true})).record.text,f.record.text);
    a.close();b.close();
  }
});

test('a closing panel late read cannot revoke another live panel sharing its snapshot',async()=>{
  const f=await fixture(),readScope={},record=f.record;let wait=null,entered;
  const value={version:1,expectedAccount:account,revision:1,entries:[{id:record.id,revision:1,updatedAt:record.updatedAt,deleted:false,record}],receipts:[]};
  const storageFactory=async()=>({read:async()=>{if(wait){const pending=wait;wait=null;entered();await pending;}return {exists:true,value:structuredClone(value)};},close(){}});
  const a=f.make({readScope,storageFactory});await a.list();let release;
  wait=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{entered=resolve;});
  const refresh=assert.rejects(a.list({cursor:null,limit:50},{revalidate:true}),{code:'text_collection_sync_account'});
  await started;a.close();const b=f.make({readScope,storageFactory});assert.equal((await b.list()).total,1);
  release();await refresh;assert.equal((await b.get(record.id,{preferCache:true})).record.text,record.text);b.close();
});

test('a late background read returns confirmed edits or deletions, not its older response',async()=>{
  for(const operation of ['edit','delete']){
  const f=await fixture(),readScope={},record=f.record;let value={version:1,expectedAccount:account,revision:1,entries:[{id:record.id,revision:1,updatedAt:record.updatedAt,deleted:false,record}],receipts:[]},wait=null,entered=null;
  const storageFactory=async()=>({read:async()=>{const captured=structuredClone(value);if(wait){const pending=wait;wait=null;entered();await pending;}return {exists:true,value:captured};},update:async(_slot,transform)=>{value=transform(structuredClone(value));return {exists:true,value};},close(){}});
  const a=f.make({readScope,storageFactory}),b=f.make({readScope,storageFactory});await a.list();await b.list();
  // Ensure b owns its transport before delaying a's refresh response.
  await b.get(record.id,{forceRefresh:true});await a.get(record.id,{forceRefresh:true});
  let release;wait=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{entered=resolve;});
  const refreshing=a.list({cursor:null,limit:50},{revalidate:true});await started;
  await b.write(operation==='edit'?edit(record,1,'并发保存的新版本','mutation-late001'):{version:1,expectedAccount:account,mutationId:'mutation-late001',operation:'delete',id:record.id,baseRevision:1});release();
  const refreshed=await refreshing,detail=await a.get(record.id);
  if(operation==='edit'){assert.equal(refreshed.items[0].preview,'并发保存的新版本');assert.equal(detail.record.text,'并发保存的新版本');}
  else{assert.equal(refreshed.items.length,0);assert.equal(detail.record,null);}
  a.close();b.close();
  }
});
