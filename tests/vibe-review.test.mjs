import test from 'node:test';
import assert from 'node:assert/strict';
import {createVibeReviewActions} from '../qianmu-vibe-review.js';
import {prepareNovelVibeEncoding} from '../qianmu-vibe-encoding.js';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
import {parseNovelVibeFile} from '../qianmu-vibe-file.js';
const namespace='st-user:one',image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
async function setup(){
  const prepared=await prepareNovelVibeEncoding({version:1,provider:'novel',model:'nai-diffusion-4-full',baseUrl:'https://relay.example',image,information:0});
  const row={namespace,...prepared,attemptId:'one-attempt',status:'unknown',updatedAt:1};delete row.body;
  const operations=[],remote={status:'ready',attemptId:'b'.repeat(64)};let changed=false,lock=true,live=true,save={reconciled:true,assetRef:{version:1,namespace,id:'a'.repeat(64)}};
  const call=async(type,args)=>{operations.push(type);assert.equal(args.namespace,namespace);if(type==='encoding-list')return [row];if(type==='encoding-get')return changed?{...row,status:'ready'}:row;if(type==='recover-encoding')return save;return new Blob(['fixture']);};
  const service={query:async()=>remote,result:async()=>({identity:row.identity,encoding:btoa('binary'),cacheKey:row.cacheKey,serviceAttemptId:remote.attemptId}),encode:()=>assert.fail('review never encodes')};
  const actions=createVibeReviewActions({namespace,call,service,guard:async()=>{if(!live)throw Error('changed account');},locks:{request:async(name,options,work)=>{
    assert.equal(name,'qianmu:nai-maintenance');assert.deepEqual(options,{mode:'exclusive',ifAvailable:true});return work(lock?{}:null);
  }}});
  return {row,actions,operations,remote,service,changed:()=>changed=true,locked:()=>lock=false,invalid:()=>live=false,setSave:value=>save=value};
}
test('review lists metadata and retrieves the exact service attempt without any paid call',async()=>{
  const e=await setup();assert.equal((await e.actions.list()).length,1);assert.equal((await e.actions.receive(e.row)).reconciled,true);assert.deepEqual(e.operations,['encoding-list','encoding-get','recover-encoding']);
});
test('review refuses a live generation, changed receipt, account switch, pending response and changed result attempt',async()=>{
  for(const change of [e=>e.locked(),e=>e.changed(),e=>e.invalid(),e=>e.remote.status='pending',e=>e.service.result=async()=>({serviceAttemptId:'c'.repeat(64)})]){
    const e=await setup();change(e);await assert.rejects(()=>e.actions.receive(e.row));assert.equal(e.operations.includes('recover-encoding'),false);
  }
});
test('missing originals provide standalone encoded export while unbound old receipts remain explicitly unreconciled',async()=>{
  const e=await setup();e.setSave({sourceMissing:true});const result=await e.actions.receive(e.row);assert.ok(result.blob instanceof Blob);assert.match(result.warning,/原图已缺失/);assert.equal(e.operations.at(-1),'export-encoding');
  const legacy=await setup();legacy.setSave({reconciled:false,assetRef:{version:1,namespace,id:'a'.repeat(64)}});assert.equal((await legacy.actions.receive(legacy.row)).reconciled,false);
});
test('standalone recovered encoding is a complete valid official file with exact zero IE and no invented original',async()=>{
  const e=await setup(),run=createVibeAssetOperations({}),blob=await run({type:'export-encoding',namespace,cacheKey:e.row.cacheKey,identity:e.row.identity,encoding:btoa('recovered')});
  const [file]=await parseNovelVibeFile(await blob.text());assert.equal(file.document.type,'encoding');assert.equal(file.document.image,undefined);assert.equal(file.summary.variants[0].information,0);assert.equal(file.summary.variants[0].model,'v4full');
  await assert.rejects(()=>run({type:'export-encoding',namespace,cacheKey:'a'.repeat(64),identity:e.row.identity,encoding:btoa('recovered')}));
});

test('manual review cancels without a mutation, requires exact service ownership, and resumes an already confirmed service receipt',async()=>{
  const e=await setup();e.row.delivery={version:1,transport:'service',channelKey:'a'.repeat(64),serviceAttemptId:'b'.repeat(64)};
  const proof={version:1,kind:'vibe',attemptId:'b'.repeat(64),requestDigest:e.row.cacheKey,canReview:true,reviewed:false,confirmation:'c'.repeat(64),
    serviceDelivery:{version:1,channelKey:'a'.repeat(64),clientAttemptId:e.row.attemptId}};
  e.service.review=async()=>proof;let confirmations=0;
  e.service.confirmReview=async()=>{confirmations++;return {...proof,reviewed:true};};
  assert.deepEqual(await e.actions.review(e.row,async()=>false),{cancelled:true});assert.equal(confirmations,0);assert.equal(e.operations.includes('encoding-review'),false);
  await e.actions.review(e.row,async()=>true);assert.equal(confirmations,1);assert.equal(e.operations.at(-1),'encoding-review');
  proof.reviewed=true;await e.actions.review(e.row,async()=>assert.fail('already confirmed'));assert.equal(confirmations,1);
  proof.serviceDelivery.clientAttemptId='other-sender';await assert.rejects(()=>e.actions.review(e.row,async()=>true),/不能对应/);assert.equal(confirmations,1);
});

test('changed local receipt during the review dialog cannot clear the server or local fee state',async()=>{
  const e=await setup();e.row.delivery={version:1,transport:'service',channelKey:'a'.repeat(64),serviceAttemptId:'b'.repeat(64)};
  e.service.review=async()=>({canReview:true,reviewed:false,requestDigest:e.row.cacheKey,attemptId:'b'.repeat(64),confirmation:'c'.repeat(64),serviceDelivery:{version:1,channelKey:'a'.repeat(64),clientAttemptId:e.row.attemptId}});
  e.service.confirmReview=()=>assert.fail('changed local record must not clear server');
  await assert.rejects(()=>e.actions.review(e.row,async()=>{e.changed();return true;}),/本机记录已变化/);assert.equal(e.operations.includes('encoding-review'),false);
});
