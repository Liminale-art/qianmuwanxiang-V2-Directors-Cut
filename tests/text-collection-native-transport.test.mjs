import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createNativeCollectionTransport} from '../qianmu-text-collection-native-transport.js';
import {nativeCollectionWriteRequest,nativeCollectionWriteResponse,nativeCollectionCapabilities,NATIVE_COLLECTION_PROTOCOL} from '../qianmu-text-collection-native-contract.js';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const account='st-user:'+'a'.repeat(64),scope='b'.repeat(64),origin='https://st.fixture.invalid';
const mutation={version:1,expectedAccount:account,mutationId:'mutation-0001',operation:'delete',id:'collection-0001',baseRevision:1};
const request={version:1,expectedAccount:account,mutations:[mutation]};
const capability={ok:true,version:1,expectedAccount:account,nativeProtocol:NATIVE_COLLECTION_PROTOCOL,indexVersion:2};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function response(input=request,libraryRevision=2){
  const results=input.mutations.map(item=>({ok:true,version:1,expectedAccount:account,libraryRevision,mutationId:item.mutationId,id:item.id,revision:item.baseRevision+1,updatedAt:2}));
  const value={version:2,expectedAccount:account,revision:libraryRevision,entries:results.map(item=>({id:item.id,revision:item.revision,updatedAt:item.updatedAt,deleted:true,record:null})),receipts:results.map((item,index)=>({...item,hash:sha(input.mutations[index])}))};
  return {ok:true,version:1,expectedAccount:account,scope,verified:{value,fingerprint:sha({schema:NATIVE_COLLECTION_PROTOCOL,scope,slot:'collections',value})},acknowledgements:{ok:true,version:1,expectedAccount:account,libraryRevision,results}};
}
function fixture(t,handler,extra={}){
  const calls=[];let current=true;
  const client=createNativeCollectionTransport({expectedAccount:account,scope,origin,readScope:{},guard:async()=>current,headers:()=>({'X-CSRF-Token':'fixture','Authorization':'must-not-forward'}),
    fetchImpl:async(url,options)=>{calls.push({url,options});assert.equal(new URL(url).origin,origin);assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers['X-CSRF-Token'],'fixture');return handler?handler(url,options):json(options.method==='GET'?capability:response());},...extra});
  t.after(()=>client.close());return {client,calls,setCurrent:value=>{current=value;}};
}

test('capability negotiation once, then one POST per verified write; no user-files transport',async t=>{
  const f=fixture(t);const result=await f.client.tryWrite(request);
  assert.equal(result.verified.value.revision,2);assert.equal(f.calls.length,2);assert.deepEqual(JSON.parse(f.calls[1].options.body),request);
  await f.client.tryWrite(request);assert.equal(f.calls.length,3);assert.deepEqual(f.calls.map(row=>row.options.method),['GET','POST','POST']);
  assert.ok(f.calls.every(row=>!row.url.includes('/user/files/')&&!row.url.includes('/api/files/upload')));
});
for(const status of [404,405,501])test(`missing capability ${status} selects native path before any mutation`,async t=>{
  const f=fixture(t,()=>json({},status));assert.equal(await f.client.tryWrite(request),null);assert.equal(await f.client.tryWrite(request),null);assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.method,'GET');
});
test('capability network failure may select existing path but dispatches no write',async t=>{
  const f=fixture(t,()=>{throw Error('offline');});assert.equal(await f.client.tryWrite(request),null);assert.equal(f.calls.length,1);
});
for(const status of [401,403])test(`capability auth rejection ${status} rejects rather than fallback`,async t=>{
  const f=fixture(t,()=>json({},status));await assert.rejects(f.client.tryWrite(request),error=>error.code==='text_collection_sync_account'&&error.writeState==='not_started');assert.equal(f.calls.length,1);
});
test('a capability for another account cannot fall back or dispatch a mutation',async t=>{
  const f=fixture(t,()=>json({...capability,expectedAccount:'st-user:'+'c'.repeat(64)}));await assert.rejects(f.client.tryWrite(request),{code:'text_collection_sync_account'});assert.equal(f.calls.length,1);
});
for(const failure of ['offline','404','401','corrupt','redirect','wrong-path'])test(`dispatched mutation ${failure} never falls back to file uploads`,async t=>{
  const f=fixture(t,(_url,options)=>{
    if(options.method==='GET')return json(capability);
    if(failure==='offline')throw Error('lost receipt');
    if(['404','401'].includes(failure))return json({},Number(failure));
    if(failure==='corrupt')return json({...response(),verified:{value:response().verified.value,fingerprint:'d'.repeat(64)}});
    const result=json(response());Object.defineProperty(result,failure==='redirect'?'redirected':'url',{value:failure==='redirect'?true:origin+'/other'});return result;
  });
  await assert.rejects(f.client.tryWrite(request),error=>error.writeState==='unconfirmed');assert.equal(f.calls.length,2);assert.equal(f.calls.filter(row=>row.options.method==='POST').length,1);
});
test('late mutation response after account loss is rejected',async t=>{
  let f;f=fixture(t,(_url,options)=>{if(options.method==='POST')f.setCurrent(false);return json(options.method==='GET'?capability:response());});
  await assert.rejects(f.client.tryWrite(request),error=>error.code==='text_collection_sync_account'&&error.writeState==='unconfirmed');assert.equal(f.calls.length,2);
});
test('closed or aborted operation cannot discover or submit',async t=>{
  const f=fixture(t),controller=new AbortController();controller.abort();await assert.rejects(f.client.tryWrite(request,{signal:controller.signal}),{code:'text_collection_sync_cancelled'});
  f.client.close();await assert.rejects(f.client.tryWrite(request),{code:'text_collection_sync_cancelled'});assert.equal(f.calls.length,0);
});
test('capability expires and changed account/configuration cannot borrow a support memo',async t=>{
  let now=0;const readScope={};const f=fixture(t,null,{readScope,now:()=>now});await f.client.tryWrite(request);now=60001;await f.client.tryWrite(request);assert.equal(f.calls.filter(row=>row.options.method==='GET').length,2);
  const g=fixture(t,null,{readScope:{}});await g.client.tryWrite(request);assert.equal(g.calls[0].options.method,'GET');
});
for(const changedSupport of ['404','older-index','offline'])test(`unconfirmed dispatched write bypasses expired ${changedSupport} capability in a reopened transport`,async t=>{
  const readScope={};let now=0,posts=0,capabilityChanged=false;
  const handler=(_url,options)=>{
    if(options.method==='GET'){
      if(!capabilityChanged)return json(capability);
      if(changedSupport==='offline')throw Error('capability offline');
      return changedSupport==='404'?json({},404):json({...capability,indexVersion:1});
    }
    if(++posts===1)throw Error('accepted write, receipt lost');
    return json(response(JSON.parse(options.body)));
  };
  const first=fixture(t,handler,{readScope,now:()=>now});
  await assert.rejects(first.client.tryWrite(request),error=>error.writeState==='unconfirmed');
  first.client.close();now=60001;capabilityChanged=true;
  const reopened=fixture(t,handler,{readScope,now:()=>now});
  const result=await reopened.client.tryWrite(request);
  assert.ok(result,'an already dispatched mutation must not return null and select the browser file write path');
  assert.equal(result.acknowledgements.results[0].mutationId,mutation.mutationId);
  assert.deepEqual(first.calls.map(row=>row.options.method),['GET','POST']);
  assert.deepEqual(reopened.calls.map(row=>row.options.method),['POST']);
  assert.deepEqual(JSON.parse(reopened.calls[0].options.body),request);
});
test('a split retry batch containing an unconfirmed mutation cannot select the old file path after capability TTL',async t=>{
  const readScope={};let now=0,posts=0;
  const batch={...request,mutations:[{...mutation,mutationId:'mutation-0002',id:'collection-0002'},mutation]};
  const f=fixture(t,(_url,options)=>{
    if(options.method==='GET')return now===0?json(capability):json({},404);
    if(++posts===1)throw Error('first batch receipt lost');
    return json(response(JSON.parse(options.body),3));
  },{readScope,now:()=>now});
  await assert.rejects(f.client.tryWrite(request),error=>error.writeState==='unconfirmed');
  now=60001;
  const result=await f.client.tryWrite(batch);
  assert.ok(result,'a mixed retry batch must stay on the server endpoint if any mutation was already dispatched');
  assert.deepEqual(result.acknowledgements.results.map(row=>row.mutationId),batch.mutations.map(row=>row.mutationId));
  assert.deepEqual(f.calls.map(row=>row.options.method),['GET','POST','POST']);
  assert.deepEqual(JSON.parse(f.calls[2].options.body),batch);
});
test('a dispatched retry rejected by the native write endpoint remains unconfirmed across further capability expiry',async t=>{
  let now=0,posts=0;
  const f=fixture(t,(_url,options)=>{
    if(options.method==='GET')return now===0?json(capability):json({},404);
    ++posts;if(posts===1)throw Error('accepted write, receipt lost');
    return posts===2?json({},404):json(response());
  },{now:()=>now});
  await assert.rejects(f.client.tryWrite(request),error=>error.writeState==='unconfirmed');
  now=60001;
  await assert.rejects(f.client.tryWrite(request),error=>error.writeState==='unconfirmed');
  now=120002;
  assert.ok(await f.client.tryWrite(request),'unknown writes stay pinned until a verified response is received');
  assert.deepEqual(f.calls.map(row=>row.options.method),['GET','POST','POST','POST']);
  assert.ok(f.calls.filter(row=>row.options.method==='POST').every(row=>row.options.body===JSON.stringify(request)));
  now=180003;
  assert.equal(await f.client.tryWrite(request),null,'a verified receipt releases the operation pin and ordinary capability probing can resume');
  assert.deepEqual(f.calls.map(row=>row.options.method),['GET','POST','POST','POST','GET']);
});
test('contract rejects duplicated targets, oversized batches and added path fields',()=>{
  assert.throws(()=>nativeCollectionWriteRequest({...request,path:'elsewhere'}));assert.throws(()=>nativeCollectionWriteRequest({...request,mutations:[mutation,mutation]}));
  assert.throws(()=>nativeCollectionWriteRequest({...request,mutations:Array(33).fill(mutation)}));assert.throws(()=>nativeCollectionCapabilities({...capability,root:'elsewhere'},account));
});
for(const defect of ['hash','receipt','account','ack','extra','fingerprint'])test(`verified response rejects ${defect}`,async()=>{
  const result=response();
  if(defect==='hash')result.verified.value.receipts[0].hash='f'.repeat(64);
  if(defect==='receipt')result.verified.value.receipts=[];
  if(defect==='account')result.expectedAccount='st-user:'+'f'.repeat(64);
  if(defect==='ack')result.acknowledgements.results[0].revision=3;
  if(defect==='extra')result.verified.path='elsewhere';
  if(defect==='fingerprint')result.verified.fingerprint='f'.repeat(64);
  else result.verified.fingerprint=sha({schema:NATIVE_COLLECTION_PROTOCOL,scope,slot:'collections',value:result.verified.value});
  await assert.rejects(nativeCollectionWriteResponse(result,request,{scope}));
});
