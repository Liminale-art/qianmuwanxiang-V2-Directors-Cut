import test from 'node:test';
import assert from 'node:assert/strict';
import {createVibeEncodingStore,validateVibeEncodingIdentity,validateVibeEncodingDelivery,validateVibeServiceDelivery,matchesVibeServiceDelivery} from '../qianmu-vibe-encoding-store.js';
import {prepareNovelVibeEncoding} from '../qianmu-vibe-encoding.js';
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const prepared=()=>prepareNovelVibeEncoding({version:1,provider:'novel',baseUrl:'https://relay.example',model:'nai-diffusion-4-full',image,information:0});

test('cache equality alone cannot settle a different device, API Key, backend submission or legacy fee receipt',()=>{
  const serviceAttemptId='a'.repeat(64),proof={version:1,channelKey:'b'.repeat(64),clientAttemptId:'local-attempt-one'},row={attemptId:proof.clientAttemptId,delivery:{version:1,transport:'service',channelKey:proof.channelKey,serviceAttemptId}};
  assert.equal(matchesVibeServiceDelivery(row,serviceAttemptId,proof),true);
  for(const other of [undefined,{...proof,channelKey:'c'.repeat(64)},{...proof,clientAttemptId:'local-attempt-two'}])assert.equal(matchesVibeServiceDelivery(row,serviceAttemptId,other),false);
  assert.equal(matchesVibeServiceDelivery(row,'c'.repeat(64),proof),false);assert.equal(matchesVibeServiceDelivery({attemptId:proof.clientAttemptId},serviceAttemptId,proof),false);
  for(const bad of [null,{...proof,apiKey:'secret'},{...proof,clientAttemptId:'short'},{...proof,version:2}])assert.throws(()=>validateVibeServiceDelivery(bad));
});
test('encoding receipts are lazy and fail closed when durable storage is unavailable',async()=>{
  let opens=0;const store=createVibeEncodingStore({indexedDB:{open(name,version){opens++;assert.equal(name,'qianmu-vibe-encodings');assert.equal(version,2);throw Error();}}});
  assert.equal(opens,0);const value=await prepared();await assert.rejects(()=>store.reserve('st-user:one',value.cacheKey,value.identity,'attempt-one'),{code:'vibe_encoding_cache_storage'});assert.equal(opens,1);
  store.close();await assert.rejects(()=>store.get('st-user:one',value.cacheKey),{code:'vibe_encoding_cache_closed'});assert.equal(opens,1);
});
test('receipt validation forbids credentials/bytes, invalid digest, model/IE mismatch and unknown fields before opening DB',async()=>{
  const value=await prepared();assert.deepEqual(await validateVibeEncodingIdentity(value.identity,value.cacheKey),value.identity);
  for(const change of [v=>v.apiKey='secret',v=>v.image=image,v=>v.parameters.mask=image,v=>v.parameters.information_extracted=.7,
    v=>v.encodingModel='v4-5full',v=>v.endpoint='http://unsafe.example/ai/encode-vibe',v=>v.remoteModelId=' x ']){
    const copy=structuredClone(value.identity);change(copy);await assert.rejects(()=>validateVibeEncodingIdentity(copy,value.cacheKey));
  }
  let opens=0;const store=createVibeEncodingStore({indexedDB:{open(){opens++;throw Error();}}});
  await assert.rejects(()=>store.get('other',value.cacheKey));await assert.rejects(()=>store.reserve('st-user:one',value.cacheKey,value.identity,'short'));
  assert.equal(opens,0);store.close();
});
test('late blocked receipt DB openings close rather than authorize a pending request',async()=>{
  let request,closed=0;const store=createVibeEncodingStore({indexedDB:{open(){request={};return request;}}});
  const reading=store.get('st-user:one','a'.repeat(64));request.onblocked();await assert.rejects(reading,{code:'vibe_encoding_cache_blocked'});
  request.result={close:()=>closed++};request.onsuccess();assert.equal(closed,1);store.close();
});
test('delivery provenance is closed, account-local and never stores credentials or request bodies',async()=>{
  const value={version:1,transport:'service',channelKey:'a'.repeat(64),serviceAttemptId:'b'.repeat(64)};
  assert.deepEqual(validateVibeEncodingDelivery(value),value);
  for(const edit of [v=>v.apiKey='secret',v=>v.image=image,v=>v.transport='other',v=>v.serviceAttemptId='short',v=>v.channelKey='secret',v=>v.transport='direct']){
    const row=structuredClone(value);edit(row);assert.throws(()=>validateVibeEncodingDelivery(row));
  }
  let opens=0;const store=createVibeEncodingStore({indexedDB:{open(){opens++;throw Error();}}}),item=await prepared();
  await assert.rejects(()=>store.reserve('st-user:one',item.cacheKey,item.identity,'attempt-one',{sourceAssetRef:{version:1,namespace:'st-user:two',id:'a'.repeat(64)},delivery:value}));assert.equal(opens,0);store.close();
});

test('local review confirmation fingerprints one exact receipt and explicitly differs from service proof',async()=>{
  const value=await prepared(),store=createVibeEncodingStore(),row={namespace:'st-user:one',cacheKey:value.cacheKey,identity:value.identity,attemptId:'attempt-one',status:'unknown',revision:1,createdAt:1,updatedAt:2};
  const get=async()=>row,plan=()=>store.previewLocalReview.call({get},row.namespace,row.cacheKey,structuredClone(row));
  const first=await plan();assert.equal(first.method,'local-user');assert.match(first.confirmation,/^[a-f0-9]{64}$/);assert.equal(first.requestDigest,value.cacheKey);assert.equal(first.attemptId,row.attemptId);
  assert.deepEqual(await plan(),first);row.updatedAt++;assert.notEqual((await plan()).confirmation,first.confirmation);
  row.updatedAt--;row.namespace='st-user:other';assert.notEqual((await plan()).confirmation,first.confirmation);
  row.namespace='st-user:one';row.delivery={version:1,transport:'direct',channelKey:'a'.repeat(64)};assert.notEqual((await plan()).confirmation,first.confirmation);
  row.delivery.transport='service';row.delivery.serviceAttemptId='b'.repeat(64);await assert.rejects(plan,/不能用本机确认替代/);store.close();
});

test('local review refuses completed, changed and absent receipts and rejects missing or altered consent before opening a write transaction',async()=>{
  let opens=0;const store=createVibeEncodingStore({indexedDB:{open(){opens++;throw Error('no storage');}}}),value=await prepared();
  const row={namespace:'st-user:one',cacheKey:value.cacheKey,identity:value.identity,attemptId:'attempt-one',status:'unknown',updatedAt:1},ns=row.namespace,key=row.cacheKey;
  for(const actual of [null,{...row,status:'ready'},{...row,status:'rejected'},{...row,status:'reviewed'}]){
    await assert.rejects(()=>store.previewLocalReview.call({get:async()=>actual},ns,key,actual));
  }
  await assert.rejects(()=>store.previewLocalReview.call({get:async()=>({...row,updatedAt:2})},ns,key,row),/记录已变化/);
  const proof=await store.previewLocalReview.call({get:async()=>row},ns,key,row),self={previewLocalReview:async()=>proof};
  for(const confirmed of [false,1,'true',undefined])await assert.rejects(()=>store.reviewLocal.call(self,ns,key,row,proof,confirmed),/尚未确认/);
  for(const changed of [{...proof,confirmation:'a'.repeat(64)},{...proof,attemptId:'other-attempt'},{...proof,reviewed:true}]){
    await assert.rejects(()=>store.reviewLocal.call(self,ns,key,row,changed,true),/尚未确认/);
  }assert.equal(opens,0);store.close();
});
