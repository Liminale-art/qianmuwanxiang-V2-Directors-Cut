import test from 'node:test';
import assert from 'node:assert/strict';
import {createVibeReviewActions} from '../qianmu-vibe-review.js';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
import {createVibeEncodingStore} from '../qianmu-vibe-encoding-store.js';
import {createVibeStorageOperations} from '../qianmu-vibe-storage.js';
import {prepareNovelVibeEncoding} from '../qianmu-vibe-encoding.js';
import {inspectVibeReceiptFile} from '../qianmu-vibe-receipt-file.js';

const namespace='st-user:archive';
async function receipt(){
  const prepared=await prepareNovelVibeEncoding({version:1,provider:'novel',baseUrl:'https://relay.example',model:'nai-diffusion-4-full',information:0,
    image:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=='});
  return {key:JSON.stringify([namespace,prepared.cacheKey]),namespace,cacheKey:prepared.cacheKey,identity:prepared.identity,
    attemptId:'finished-original',status:'ready',revision:1,createdAt:1,updatedAt:2,assetRef:{version:1,namespace,id:'a'.repeat(64)}};
}
function actions(call,guard=async()=>{}){return createVibeReviewActions({namespace,call,guard,service:new Proxy({}, {get(){throw Error('No remote calls permitted');}})});}

test('archiving is explicit, strictly confirmed and described as keeping evidence rather than clearing disk or fees',async()=>{
  const row=await receipt(),calls=[],api=actions(async(type,args)=>{calls.push({type,args});return {archived:1};});
  for(const answer of [false,undefined,1,'yes',{}])assert.deepEqual(await api.archiveCompleted([row],async()=>answer),{cancelled:true});
  assert.equal(calls.length,0);
  assert.deepEqual(await api.archiveCompleted([row],async(title,text)=>{
    assert.match(title,/归档/);assert.match(text,/不释放磁盘/);assert.match(text,/不重新编码/);assert.match(text,/不把历史未知费用改为已结清/);return true;
  }),{archived:1});
  assert.deepEqual(calls,[{type:'encoding-archive',args:{namespace,expected:[row],confirmed:true}}]);
});

test('archive selection is bounded, copied before waiting, account-scoped and limited to ready receipts',async()=>{
  const row=await receipt(),original=structuredClone(row),calls=[],api=actions(async(_type,args)=>calls.push(args));
  for(const rows of [[],Array(41).fill(row),[row,row],[{...row,namespace:'st-user:other'}],...[ 'unknown','reserved','submitting','rejected','reviewed'].map(status=>[{...row,status}])]){
    await assert.rejects(()=>api.archiveCompleted(rows,async()=>{throw Error('must not confirm');}));
  }
  assert.equal(calls.length,0);
  const selected=[row];await api.archiveCompleted(selected,async()=>{row.attemptId='mutated-after-confirm';selected.length=0;return true;});
  assert.deepEqual(calls[0].expected,[original]);
});

test('account changes during confirmation cannot send an archive mutation',async()=>{
  const row=await receipt();let live=true,calls=0;
  const api=actions(async()=>calls++,async()=>{if(!live)throw Error('account changed');});
  await assert.rejects(()=>api.archiveCompleted([row],async()=>{live=false;return true;}),/account changed/);assert.equal(calls,0);
});

test('archive worker requires strict consent and exclusive NAI maintenance before the atomic store operation',async()=>{
  const row=await receipt(),calls=[];let granted=true;
  const locks={request:async(name,options,work)=>{assert.equal(name,'qianmu:nai-maintenance');assert.deepEqual(options,{mode:'exclusive',ifAvailable:true});return work(granted?{}:null);}};
  const encodings={archiveCompleted:async(...args)=>{calls.push(args);return {archived:1};}},run=createVibeAssetOperations({}, {encodings,locks});
  for(const confirmed of [false,1,'yes'])await assert.rejects(()=>run({type:'encoding-archive',namespace,expected:[row],confirmed}));
  granted=false;await assert.rejects(()=>run({type:'encoding-archive',namespace,expected:[row],confirmed:true}),/正在等待或生成/);assert.equal(calls.length,0);
  await assert.rejects(()=>createVibeAssetOperations({}, {encodings,locks:null})({type:'encoding-archive',namespace,expected:[row],confirmed:true}),/不支持跨页/);
  granted=true;assert.deepEqual(await run({type:'encoding-archive',namespace,expected:[row],confirmed:true}),{archived:1});assert.deepEqual(calls,[[namespace,[row],true]]);
});

test('archive store rejects invalid batches and cross-account records before opening a database',async()=>{
  const row=await receipt();let opens=0;
  const store=createVibeEncodingStore({indexedDB:{open(){opens++;throw Error('no database');}}});
  for(const [ns,rows,confirmed] of [[namespace,[row],1],[namespace,[],true],[namespace,[row,row],true],[namespace,[{...row,status:'unknown'}],true],['st-user:other',[row],true]]){
    await assert.rejects(()=>store.archiveCompleted(ns,rows,confirmed));
  }
  await assert.rejects(()=>store.archivePage(namespace,{after:'bad cursor'}));assert.equal(opens,0);store.close();
});

test('historical page and page export preserve exact records and old audit format with no restore capability',async()=>{
  const row=await receipt(),run=createVibeAssetOperations({}, {encodings:{get:async()=>structuredClone(row),archivePage:async(ns,options)=>{
    assert.equal(ns,namespace);assert.deepEqual(options,{after:'b'.repeat(64)});return {rows:[row],next:'',count:1,bytes:100};
  }}}),api=actions((type,args)=>run({type,...args}));
  assert.deepEqual((await api.archivePage('b'.repeat(64))).rows,[row]);
  const file=await api.exportPage([row]),inspected=await inspectVibeReceiptFile(namespace,file);
  assert.deepEqual(inspected.receipts,[row]);
  await assert.rejects(()=>api.exportPage([{...row,namespace:'st-user:other'}]));
  await assert.rejects(()=>api.exportPage([{...row,revision:2}]),/已变化/);
  await assert.rejects(()=>api.exportPage(Array(41).fill(row)),/1～40/);
});

test('Vibe file usage includes archived receipt metadata and still refuses cleanup if archive inventory cannot be verified',async()=>{
  let broken=false;
  const ops=createVibeStorageOperations({store:{inventory:async()=>({heads:[],usage:{count:0,bytes:0,previewBytes:0,limit:1}})},
    encodings:{inventory:async()=>{if(broken)throw Error('corrupt archive usage');return {receipts:[],archived:{count:17,bytes:5000}};}}});
  const view=await ops.inventory(namespace);assert.equal(view.receiptCount,17);assert.equal(view.archivedReceiptCount,17);assert.equal(view.receiptBytes,5000);assert.equal(view.pendingCount,0);
  broken=true;await assert.rejects(()=>ops.inventory(namespace),/corrupt archive/);
});
