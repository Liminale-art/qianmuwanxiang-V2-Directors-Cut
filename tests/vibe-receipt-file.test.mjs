import test from 'node:test';
import assert from 'node:assert/strict';
import {exportVibeReceiptFile,inspectVibeReceiptFile,VIBE_RECEIPT_FILE_LIMIT} from '../qianmu-vibe-receipt-file.js';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
import {createVibeReviewActions} from '../qianmu-vibe-review.js';
import {prepareNovelVibeEncoding} from '../qianmu-vibe-encoding.js';
const namespace='st-user:receipt-owner',image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
async function receipt(){
  const {cacheKey,identity}=await prepareNovelVibeEncoding({version:1,provider:'novel',baseUrl:'https://relay.example',model:'nai-diffusion-4-full',image,information:0});
  return {key:JSON.stringify([namespace,cacheKey]),namespace,cacheKey,identity,attemptId:'original-attempt',status:'unknown',revision:1,createdAt:1,updatedAt:2,
    sourceAssetRef:{version:1,namespace,id:'a'.repeat(64)},delivery:{version:1,transport:'direct',channelKey:'b'.repeat(64)},
    pastReviews:[{attemptId:'historical-attempt',feeReview:{version:1,method:'local-user',confirmation:'c'.repeat(64),previousStatus:'unknown',at:1}}]};
}
const save=rows=>exportVibeReceiptFile(namespace,rows,{now:()=>123});
const blob=value=>new Blob([JSON.stringify(value)],{type:'application/json'});
const noWork=new Proxy({}, {get:()=>()=>assert.fail('audit must not access media, service or mutation methods')});

test('audit export preserves exact current uncertainty, source identity, delivery and local historical evidence without image bytes',async()=>{
  const row=await receipt(),file=await save([row]),snapshot=await inspectVibeReceiptFile(namespace,file);
  assert.deepEqual(snapshot.receipts,[row]);assert.equal(snapshot.exportedAt,123);assert.equal(snapshot.bytes,file.size);assert.match(snapshot.fingerprint,/^[a-f0-9]{64}$/);
  const raw=await file.text();assert.equal(raw.includes(image),false);assert.equal(raw.includes('apiKey'),false);
  const document=JSON.parse(raw);assert.equal(document.purpose,'audit-only');assert.equal(document.identifier,'qianmu-vibe-receipts');assert.equal(document.version,1);
  assert.equal(row.status,'unknown');assert.equal(row.pastReviews.length,1);
});

test('all receipt states and full 32-review history survive export; service and local review remain distinct',async()=>{
  for(const status of ['reserved','submitting','unknown','rejected','ready','reviewed']){
    const row=await receipt();row.status=status;
    if(status==='ready')row.assetRef={version:1,namespace,id:'d'.repeat(64)};
    if(status==='reviewed')row.feeReview={version:1,method:'local-user',confirmation:'e'.repeat(64),previousStatus:'submitting',at:2};
    row.pastReviews=Array.from({length:32},(_,i)=>({attemptId:`historic-${i}`,delivery:{version:1,transport:'service',channelKey:'b'.repeat(64),serviceAttemptId:'a'.repeat(64)},feeReview:{version:1,confirmation:'c'.repeat(64),previousStatus:'unknown',at:1}}));
    assert.deepEqual((await inspectVibeReceiptFile(namespace,await save([row]))).receipts,[row]);
  }
});

test('audit digest accepts reordered object keys and formatting but rejects changed content or hashes',async()=>{
  const document=JSON.parse(await (await save([await receipt()])).text());
  const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reorder(v)])):value;
  assert.equal((await inspectVibeReceiptFile(namespace,blob(reorder(document)))).fingerprint,document.fingerprint);
  for(const edit of [v=>v.exportedAt++,v=>v.receipts[0].status='rejected',v=>v.fingerprint='a'.repeat(64)]){
    const changed=structuredClone(document);edit(changed);await assert.rejects(()=>inspectVibeReceiptFile(namespace,blob(changed)),/摘要不符/);
  }
});

test('schema rejects credentials, media, forged source, cross-account references, duplicate and overlong histories',async()=>{
  for(const edit of [r=>r.apiKey='secret',r=>r.identity.apiKey='secret',r=>r.identity.image=image,r=>r.delivery.apiKey='secret',
    r=>r.sourceAssetRef.apiKey='secret',r=>r.sourceAssetRef.namespace='st-user:other',r=>r.namespace='st-user:other',
    r=>r.key='wrong',r=>r.identity.parameters.information_extracted=.5,r=>r.pastReviews[0].feeReview.method='service',
    r=>r.pastReviews[0].delivery={version:1,transport:'service',channelKey:'b'.repeat(64),serviceAttemptId:'a'.repeat(64)},
    r=>r.pastReviews=Array(33).fill(r.pastReviews[0])]){
    const row=structuredClone(await receipt());edit(row);await assert.rejects(()=>save([row]));
  }
  const row=await receipt();await assert.rejects(()=>save([row,row]),/重复请求/);await assert.rejects(()=>save([]));await assert.rejects(()=>save(Array(2049).fill(row)));
});

test('file inspection rejects wrong type, account, unsupported purposes, extra fields and malformed JSON before any storage access',async()=>{
  const document=JSON.parse(await (await save([await receipt()])).text());
  for(const file of [new Blob([]),blob(null),blob([]),blob({}),new Blob(['not json']),new Blob(['{']),blob({...document,version:2}),blob({...document,purpose:'restore'}),blob({...document,apiKey:'secret'})])await assert.rejects(()=>inspectVibeReceiptFile(namespace,file));
  await assert.rejects(()=>inspectVibeReceiptFile('st-user:other',blob(document)),/账户不符/);
  await assert.rejects(()=>inspectVibeReceiptFile(namespace,{size:2,text:()=>assert.fail('not Blob')}));
  const large=new Blob([new Uint8Array(VIBE_RECEIPT_FILE_LIMIT+1)]);large.text=()=>assert.fail('must reject size before reading');await assert.rejects(()=>inspectVibeReceiptFile(namespace,large),/32 MB/);
});

test('worker exports one exact snapshot or an atomic metadata listing and inspects without reading DB/media or mutating receipts',async()=>{
  const row=await receipt(),reads=[],encodings={get:async(...args)=>{reads.push(args);return structuredClone(row);},list:async ns=>{reads.push(ns);return [structuredClone(row)];}};
  const run=createVibeAssetOperations(noWork,{encodings}),args={namespace,cacheKey:row.cacheKey,expected:row};
  const one=await run({type:'encoding-export',...args}),all=await run({type:'encoding-export',namespace});
  assert.deepEqual(reads,[[namespace,row.cacheKey],namespace]);
  const inspect=createVibeAssetOperations(noWork,{encodings:noWork});
  for(const file of [one,all])assert.deepEqual((await inspect({type:'encoding-inspect-file',namespace,file})).receipts,[row]);
  await assert.rejects(()=>run({type:'encoding-export',...args,expected:{...row,updatedAt:3}}),/记录已变化/);
  encodings.get=async()=>null;await assert.rejects(()=>run({type:'encoding-export',...args}),/记录已变化/);
});

test('audit actions avoid maintenance locks and service calls; stale pages/accounts cannot receive exported or inspected data',async()=>{
  const row=await receipt(),calls=[],file=await save([row]);let live=true,invalidateDuringCall=false;
  const actions=createVibeReviewActions({namespace,guard:async()=>{if(!live)throw Error('changed account');},locks:noWork,service:noWork,
    call:async(type,args)=>{calls.push([type,args]);if(invalidateDuringCall)live=false;return type==='encoding-export'?file:{receipts:[row]};}});
  assert.equal(await actions.exportRecords(row),file);assert.deepEqual(calls[0],['encoding-export',{namespace,cacheKey:row.cacheKey,expected:row}]);
  await actions.exportRecords();assert.deepEqual(calls[1],['encoding-export',{namespace}]);
  await actions.inspectFile(file);assert.equal(calls[2][0],'encoding-inspect-file');
  await assert.rejects(()=>actions.exportRecords({...row,namespace:'st-user:other'}),/不属于/);assert.equal(calls.length,3);
  for(const operation of [()=>actions.exportRecords(row),()=>actions.inspectFile(file)]){
    live=true;invalidateDuringCall=true;await assert.rejects(operation,/changed account/);
    const count=calls.length;await assert.rejects(operation,/changed account/);assert.equal(calls.length,count);
  }
});
