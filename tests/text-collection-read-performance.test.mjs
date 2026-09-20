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
  const make=()=>createNativeTextCollectionClient({expectedAccount:account,guard,isCurrent:()=>live,storageFactory:options=>createStAccountStorage({...config,...options}),legacyFactory:()=>({snapshot:()=>assert.fail('existing native file must not read the legacy service'),close(){}}),now:()=>clock});
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
