import test from 'node:test';
import assert from 'node:assert/strict';
import {createVibeReviewSegment,resolveVibeReviewHistory,checkCombinedVibeReviews,validateVibeEncodingDelivery,checkReviewSource,checkReviewHistory} from '../qianmu-vibe-history.js';
import {exportVibeReceiptFile,inspectVibeReceiptFile} from '../qianmu-vibe-receipt-file.js';
import {createVibeReviewActions} from '../qianmu-vibe-review.js';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
import {prepareNovelVibeEncoding} from '../qianmu-vibe-encoding.js';
const namespace='st-user:history',cacheKey='a'.repeat(64),reference=s=>({version:1,id:s.id,count:s.count});
const reviews=(start,count)=>Array.from({length:count},(_,i)=>({attemptId:`review-${start+i}`,feeReview:{version:1,method:'local-user',confirmation:'b'.repeat(64),previousStatus:'unknown',at:start+i}}));
async function chain(){const first=await createVibeReviewSegment(namespace,cacheKey,null,reviews(100,32)),second=await createVibeReviewSegment(namespace,cacheKey,reference(first),reviews(200,16));return {first,second,ref:reference(second)};}

test('extracted legacy validators preserve their established error categories and submission boundary',()=>{
  const expected=code=>({code:`vibe_encoding_cache_${code}`,submissionState:'not_submitted'});
  assert.throws(()=>validateVibeEncodingDelivery({}),expected('identity'));
  assert.throws(()=>checkReviewSource({feeReview:{}}),expected('corrupt'));
  assert.throws(()=>checkReviewSource({feeReview:{...reviews(100,1)[0].feeReview,method:undefined}}),expected('corrupt'));
  assert.throws(()=>checkReviewHistory([{}]),expected('corrupt'));
  assert.throws(()=>checkReviewHistory(reviews(100,33)),expected('capacity'));
});
test('immutable review segments resolve in original order and retain unknown local/service provenance',async()=>{
  const {first,second,ref}=await chain();assert.deepEqual(await resolveVibeReviewHistory(namespace,cacheKey,ref,[second,first]),[...reviews(100,32),...reviews(200,16)]);
  const service={attemptId:'service-original',delivery:{version:1,transport:'service',channelKey:'c'.repeat(64),serviceAttemptId:'d'.repeat(64)},feeReview:{version:1,confirmation:'e'.repeat(64),previousStatus:'submitting',at:1}};
  const mixed=await createVibeReviewSegment(namespace,cacheKey,ref,[service]);assert.deepEqual((await resolveVibeReviewHistory(namespace,cacheKey,reference(mixed),[first,second,mixed])).at(-1),service);
});
test('missing, tampered, additional, cross-account and detached history fails closed',async()=>{
  const {first,second,ref}=await chain(),changed=structuredClone(first);changed.reviews[0].feeReview.at++;
  for(const [ns,key,index,segments] of [[namespace,cacheKey,ref,[second]],[namespace,cacheKey,ref,[changed,second]],['st-user:other',cacheKey,ref,[first,second]],
    [namespace,'f'.repeat(64),ref,[first,second]],[namespace,cacheKey,null,[first]],[namespace,cacheKey,reference(first),[first,second]],[namespace,cacheKey,ref,[first,first,second]]]){
    await assert.rejects(()=>resolveVibeReviewHistory(ns,key,index,segments));
  }
});
test('duplicate attempts across segments/current rows and false service provenance are rejected',async()=>{
  const {first}=await chain(),duplicate=await createVibeReviewSegment(namespace,cacheKey,reference(first),reviews(100,16));
  await assert.rejects(()=>resolveVibeReviewHistory(namespace,cacheKey,reference(duplicate),[first,duplicate]),/重复/);
  assert.throws(()=>checkCombinedVibeReviews({pastReviews:reviews(100,1)},reviews(100,2)),/重复/);
  assert.throws(()=>checkCombinedVibeReviews({attemptId:'review-100',feeReview:reviews(100,1)[0].feeReview},reviews(100,2)),/重复/);
  await assert.rejects(()=>createVibeReviewSegment(namespace,cacheKey,null,[{...reviews(100,1)[0],delivery:{version:1,transport:'service',channelKey:'c'.repeat(64),serviceAttemptId:'d'.repeat(64)}}]),/核查方式/);
});
test('2048 archived reviews remain verifiable, while over-capacity, unknown fields and oversized segments fail',async()=>{
  const segments=[];let ref=null;for(let i=0;i<64;i++){const segment=await createVibeReviewSegment(namespace,cacheKey,ref,reviews(1000+i*32,32));segments.push(segment);ref=reference(segment);}
  assert.equal((await resolveVibeReviewHistory(namespace,cacheKey,ref,segments)).length,2048);
  await assert.rejects(()=>createVibeReviewSegment(namespace,cacheKey,ref,reviews(4000,1)),/已满/);
  await assert.rejects(()=>createVibeReviewSegment(namespace,cacheKey,null,reviews(0,33)));
  const bad={...segments[0],apiKey:'must-not-be-kept'};await assert.rejects(()=>resolveVibeReviewHistory(namespace,cacheKey,reference(bad),[bad]));
});
async function record(){
  const p=await prepareNovelVibeEncoding({version:1,provider:'novel',baseUrl:'https://relay.example',model:'nai-diffusion-4-full',information:0,
    image:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=='});
  return {key:JSON.stringify([namespace,p.cacheKey]),namespace,cacheKey:p.cacheKey,identity:p.identity,attemptId:'current-original',revision:1,status:'unknown',createdAt:1,updatedAt:2,pastReviews:reviews(100,32)};
}
test('v2 audit exports complete separated history, keeps v1 unchanged, and cannot masquerade as an incomplete v1 file',async()=>{
  const row=await record(),segment=await createVibeReviewSegment(namespace,row.cacheKey,null,row.pastReviews),compact={...row,reviewArchive:reference(segment)};delete compact.pastReviews;
  const old=await exportVibeReceiptFile(namespace,[row]);assert.equal(JSON.parse(await old.text()).version,1);
  await assert.rejects(()=>exportVibeReceiptFile(namespace,[compact]),/缺少核查明细/);
  const blob=await exportVibeReceiptFile(namespace,[compact],{reviewSegments:[segment]}),file=JSON.parse(await blob.text());assert.equal(file.version,2);assert.equal(file.purpose,'audit-only');
  const result=await inspectVibeReceiptFile(namespace,blob);assert.deepEqual(result.reviewHistories[row.cacheKey],row.pastReviews);assert.deepEqual(result.receipts,[compact]);
  file.reviewSegments[0].reviews[0].feeReview.confirmation='0'.repeat(64);await assert.rejects(()=>inspectVibeReceiptFile(namespace,new Blob([JSON.stringify(file)])),/摘要不符/);
});
test('history actions require exact consent, keep snapshot ownership and do not invoke a service or generation',async()=>{
  const row=await record(),original=structuredClone(row),calls=[];let live=true;
  const actions=createVibeReviewActions({namespace,guard:async()=>{if(!live)throw Error('changed account');},call:async(type,args)=>{calls.push({type,args});return {moved:32};},service:new Proxy({}, {get(){throw Error('NO SERVICE');}})});
  for(const value of [false,1,'yes',{}])assert.deepEqual(await actions.compactReviews(row,async()=>value),{cancelled:true});assert.equal(calls.length,0);
  await assert.rejects(()=>actions.compactReviews(row,async()=>{live=false;return true;}),/changed account/);live=true;
  await actions.compactReviews(row,async(_title,message)=>{assert.match(message,/不代表已授权下一笔/);assert.match(message,/未知费用仍未知/);row.pastReviews=[];return true;});
  assert.deepEqual(calls,[{type:'encoding-compact-reviews',args:{namespace,cacheKey:original.cacheKey,expected:original,confirmed:true}}]);
  await assert.rejects(()=>actions.compactReviews(row,async()=>true));await assert.rejects(()=>actions.reviewHistory({...row,namespace:'st-user:other'}));
});
test('worker enforces exclusive maintenance for history writes and exports complete sidecars',async()=>{
  const row=await record(),segment=await createVibeReviewSegment(namespace,row.cacheKey,null,row.pastReviews),compact={...row,reviewArchive:reference(segment)};delete compact.pastReviews;
  let granted=false,writes=0;
  const encodings={compactReviews:async()=>{writes++;return {moved:32};},get:async()=>compact,reviewHistory:async()=>({receipt:compact,segments:[segment],reviews:row.pastReviews})};
  const run=createVibeAssetOperations({}, {encodings,locks:{request:async(name,options,work)=>{assert.equal(name,'qianmu:nai-maintenance');assert.deepEqual(options,{mode:'exclusive',ifAvailable:true});return work(granted?{}:null);}}});
  await assert.rejects(()=>run({type:'encoding-compact-reviews',namespace,cacheKey:row.cacheKey,expected:row,confirmed:1}));
  await assert.rejects(()=>run({type:'encoding-compact-reviews',namespace,cacheKey:row.cacheKey,expected:row,confirmed:true}),/正在等待或生成/);assert.equal(writes,0);
  granted=true;await run({type:'encoding-compact-reviews',namespace,cacheKey:row.cacheKey,expected:row,confirmed:true});assert.equal(writes,1);
  const file=await run({type:'encoding-export',namespace,cacheKey:row.cacheKey,expected:compact});assert.deepEqual((await inspectVibeReceiptFile(namespace,file)).reviewHistories[row.cacheKey],row.pastReviews);
});
