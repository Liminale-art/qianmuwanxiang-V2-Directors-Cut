import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createImageServiceStore} from '../qianmu-image-service-store.js';
import {createVibeEncodingService} from '../qianmu-vibe-service.js';
import {createImageService} from '../qianmu-image-service.js';
import {createNativeRequestReview} from '../qianmu-native-review-service.js';
import {normalizeNativeReceipt,normalizeNativeReview} from '../qianmu-native-review-contract.js';
import {imageServiceAccount} from '../qianmu-image-service-access.js';
import {imageServiceChannelKey} from '../qianmu-image-service-queue.js';
import {prepareNovelVibeEncoding} from '../qianmu-vibe-encoding.js';
const actor=(handle='one')=>({user:{profile:{handle,enabled:true}}}),account=imageServiceAccount(actor()).namespace;
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',key='private-test-key';
const uncertain=()=>Object.assign(Error('fixture unknown'),{submissionState:'unknown'});
async function setup(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'qianmu-native-review-')),closing=[];let posts=0,images=0;
  t.after(async()=>{for(const service of closing.reverse())await service.close();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'qianmu-native-review-'));await fs.rm(root,{recursive:true,force:true});});
  const request={version:1,provider:'novel',model:'nai-diffusion-4-5-full',protocol:'novelai',baseUrl:'https://relay.example',apiKey:key,image,information:0},prepared=await prepareNovelVibeEncoding(request);
  const input={version:1,expectedAccount:account,cacheKey:prepared.cacheKey,request,confirmed:true,clientAttemptId:'browser-attempt-one'};
  const vibes=createVibeEncodingService({dataRoot:root,encode:async(input,hooks)=>{const p=await prepareNovelVibeEncoding(input);await hooks.authorize(p.identity,p.cacheKey);posts++;throw uncertain();}});
  const pictures=createImageService({dataRoot:root,generate:async(_input,hooks)=>{await hooks.beforeSubmit();images++;throw uncertain();}});
  closing.push(vibes,pictures);
  const store=scope=>{const value=createImageServiceStore({dataRoot:root,scope,lockWaitMs:2000});closing.push(value);return value;};
  return {root,closing,vibes,pictures,store,input,posts:()=>posts,images:()=>images};
}
const consent=plan=>({confirmation:plan.confirmation,ended:true,possibleCharge:true});

test('review contract is closed, preserves an unknown fee fact, and refuses pending-occupancy acknowledgements',()=>{
  const receipt={version:1,kind:'vibe',channelKey:'a'.repeat(64),clientAttemptId:'browser-attempt'};
  assert.deepEqual(normalizeNativeReceipt(receipt),receipt);
  for(const value of [{...receipt,apiKey:'secret'},{...receipt,kind:'comfy'},{...receipt,clientAttemptId:'bad'}])assert.throws(()=>normalizeNativeReceipt(value));
  const value={version:1,confirmation:'a'.repeat(64),previousStatus:'uncertain',at:1,occupancy:null};assert.deepEqual(normalizeNativeReview(value),value);
  for(const row of [{...value,previousStatus:'refunded'},{...value,completedAt:0},{...value,force:true}])assert.throws(()=>normalizeNativeReview(row));
});

test('actual unknown Vibe review releases its exact shared gate and retains fee evidence; fresh encoding still requires new consent and original retry id',async t=>{
  const e=await setup(t);await assert.rejects(()=>e.vibes.submit(actor(),e.input));assert.equal(e.posts(),1);
  const plan=await e.vibes.review(actor(),e.input);assert.equal(plan.canReview,true);assert.equal(plan.status,'uncertain');assert.match(plan.confirmation,/^[a-f0-9]{64}$/);
  assert.equal(plan.serviceDelivery.clientAttemptId,e.input.clientAttemptId);assert.equal(plan.serviceDelivery.channelKey,imageServiceChannelKey(key));assert.equal(JSON.stringify(plan).includes(key),false);
  for(const extra of [{}, {...consent(plan),ended:false},{...consent(plan),possibleCharge:false},{...consent(plan),confirmation:'0'.repeat(64)}])await assert.rejects(()=>e.vibes.confirmReview(actor(),{...e.input,...extra}));
  assert.equal(e.posts(),1);const done=await e.vibes.confirmReview(actor(),{...e.input,...consent(plan)});assert.equal(done.reviewed,true);assert.equal(done.status,'acknowledged');
  assert.equal((await e.vibes.query(actor(),e.input)).task.status,'reviewed');assert.equal((await e.vibes.confirmReview(actor(),{...e.input,...consent(plan)})).reviewed,true);assert.equal(e.posts(),1);
  const channel=await e.store('novel-channel').inspectChannel(imageServiceChannelKey(key));assert.equal(channel.entries[0].status,'released');
  const feeKey=imageServiceChannelKey(`vibe:${account}:${e.input.cacheKey}`),before=await e.store('vibe').inspectChannel(feeKey);
  assert.equal(before.entries.length,1);assert.equal(before.entries[0].nativeReview.previousStatus,'uncertain');assert.equal(before.entries[0].nativeReceipt.clientAttemptId,e.input.clientAttemptId);
  await assert.rejects(()=>e.vibes.submit(actor(),e.input));await assert.rejects(()=>e.vibes.submit(actor(),{...e.input,retryAttemptId:plan.attemptId,confirmed:false}));assert.equal(e.posts(),1);
  await assert.rejects(()=>e.vibes.submit(actor(),{...e.input,retryAttemptId:plan.attemptId,clientAttemptId:'browser-attempt-two'}));assert.equal(e.posts(),2);
  const after=await e.store('vibe').inspectChannel(feeKey);assert.equal(after.entries.length,2);assert.deepEqual(after.entries[0],before.entries[0]);assert.equal(after.entries[1].status,'uncertain');assert.notEqual(after.entries[1].attemptId,plan.attemptId);
  assert.equal((await e.vibes.review(actor(),{...e.input,attemptId:plan.attemptId})).reviewed,true);
});

test('image review uses the same protocol, does not generate, survives old Key removal and never reveals another account record',async t=>{
  const e=await setup(t),request={provider:'novel',protocol:'novelai',model:'nai-diffusion-4-5-full',apiKey:key,prompt:'fixture'},input={schemaVersion:1,expectedAccount:account,attemptId:'original-image',automatic:false,request};
  await assert.rejects(()=>e.pictures.submit(actor(),input));assert.equal(e.images(),1);
  const lookup={schemaVersion:1,expectedAccount:account,attemptId:input.attemptId,taskLocator:{version:1,channelKey:imageServiceChannelKey(key)}};
  const plan=await e.pictures.review(actor(),lookup);assert.equal(plan.canReview,true);
  for(const person of [actor('two'),{user:{profile:{handle:'two',enabled:true,admin:true}}}]){
    await assert.rejects(()=>e.pictures.review(person,{...lookup,expectedAccount:imageServiceAccount(person).namespace}));
    await assert.rejects(()=>e.pictures.confirmReview(person,{...lookup,expectedAccount:imageServiceAccount(person).namespace,...consent(plan)}));
  }
  assert.equal((await e.pictures.confirmReview(actor(),{...lookup,...consent(plan)})).reviewed,true);assert.equal(e.images(),1);
  const old=await e.store('novel').inspectChannel(imageServiceChannelKey(key));assert.equal(old.entries[0].status,'acknowledged');assert.equal(old.entries[0].nativeReview.previousStatus,'uncertain');
  await assert.rejects(()=>e.pictures.submit(actor(),{...input,attemptId:'new-image'}));assert.equal(e.images(),2);
  const newer=await e.store('novel').inspectChannel(imageServiceChannelKey(key));assert.deepEqual(newer.entries[0],old.entries[0]);
});

test('a durable partial intent is resumable after restart, and cannot release a newer channel owner',async t=>{
  for(const failAfter of ['intent','release']){
    const e=await setup(t);await assert.rejects(()=>e.vibes.submit(actor(),e.input));
    const fee=e.store('vibe'),native=e.store('novel-channel'),feeKey=imageServiceChannelKey(`vibe:${account}:${e.input.cacheKey}`);
    const value={namespace:account,channelKey:feeKey,attemptId:e.input.cacheKey};let writes=0;
    const partial=createNativeRequestReview({dataRoot:e.root,kind:'vibe',store:{inspectChannel:(...args)=>fee.inspectChannel(...args),transaction:async(...args)=>{
      writes++;if(failAfter==='release'&&writes===2)throw Error('simulated fee completion failure');return fee.transaction(...args);
    }},channelStore:{inspectChannel:(...args)=>native.inspectChannel(...args),transaction:async(...args)=>{if(failAfter==='intent')throw Error('simulated gate failure');return native.transaction(...args);},close:async()=>{}},resultAvailable:async()=>false});e.closing.push(partial);
    const plan=await partial.inspect(value);await assert.rejects(()=>partial.confirm(value,consent(plan)));
    const saved=await fee.inspectChannel(feeKey);assert.equal(saved.entries[0].status,'uncertain');assert.equal(saved.entries[0].nativeReview.completedAt,undefined);assert.equal(saved.entries[0].nativeReview.confirmation,plan.confirmation);
    if(failAfter==='release')await native.transaction(imageServiceChannelKey(key),state=>{state.entries[0]={...state.entries[0],attemptId:'newer-request',fence:'newer-fence',ownerId:'newer-owner',status:'submitting'};return {state};});
    const resumed=createNativeRequestReview({dataRoot:e.root,kind:'vibe',store:fee,resultAvailable:async()=>false});e.closing.push(resumed);
    assert.equal((await resumed.inspect(value)).confirmation,plan.confirmation);assert.equal((await resumed.confirm(value,consent(plan))).reviewed,true);
    const current=(await native.inspectChannel(imageServiceChannelKey(key))).entries[0];assert.equal(current.status,failAfter==='release'?'submitting':'released');
    assert.equal(e.posts(),1);
  }
});

test('pending or available-result requests cannot be manually released, and changing account interrupts after intent without losing it',async t=>{
  const e=await setup(t);await assert.rejects(()=>e.vibes.submit(actor(),e.input));
  const fee=e.store('vibe'),native=e.store('novel-channel'),value={namespace:account,channelKey:imageServiceChannelKey(`vibe:${account}:${e.input.cacheKey}`),attemptId:e.input.cacheKey};
  let cached=true,valid=true;
  const review=createNativeRequestReview({dataRoot:e.root,kind:'vibe',store:fee,resultAvailable:async()=>cached});e.closing.push(review);
  assert.equal((await review.inspect(value)).canReview,false);cached=false;
  const plan=await review.inspect(value);await native.transaction(imageServiceChannelKey(key),state=>{state.entries[0].status='submitting';return {state};});
  assert.equal((await review.inspect(value)).canReview,false);await assert.rejects(()=>review.confirm(value,consent(plan)));
  await native.transaction(imageServiceChannelKey(key),state=>{state.entries[0].status='uncertain';return {state};});
  const changed=createNativeRequestReview({dataRoot:e.root,kind:'vibe',store:{inspectChannel:(...args)=>fee.inspectChannel(...args),transaction:async(...args)=>{const result=await fee.transaction(...args);valid=false;return result;}},resultAvailable:async()=>false});e.closing.push(changed);
  const next=await changed.inspect(value);await assert.rejects(()=>changed.confirm(value,consent(next),{valid:()=>valid}));
  assert.equal((await native.inspectChannel(imageServiceChannelKey(key))).entries[0].status,'uncertain');assert.ok((await fee.inspectChannel(value.channelKey)).entries[0].nativeReview);
});
