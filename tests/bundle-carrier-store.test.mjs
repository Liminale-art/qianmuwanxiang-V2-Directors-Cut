import test from 'node:test';import assert from 'node:assert/strict';
import {createBundleCarrierStore} from '../qianmu-bundle-carrier-store.js';
import {bundleCarrierHead,bundleCarrierKey,validateBundleCarrierHead,summarizeBundleCarrierStorage,validateBundleCarrierStorage,bundleCarrierOriginalHead,validateBundleCarrierOriginalHead,summarizeBundleCarrierOriginals,BUNDLE_CARRIER_ORIGINAL_LIMITS} from '../qianmu-bundle-carrier-storage-contract.js';
import {BUNDLE_CARRIER_LIMITS} from '../qianmu-bundle-carrier-contract.js';
import {buildStoryboardBundle,openStoryboardBundle} from '../qianmu-storyboard-bundle.js';
import {createBundleCarrierProof,inspectBundleCarrierProof} from '../qianmu-bundle-carrier.js';
import {mappingReceiptsFixture} from './fixtures/storyboard-mapping-receipts.mjs';
import {captureBundleMappings} from '../qianmu-bundle-mappings.js';
const namespace='st-user:carrier-store',bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
async function fixture(){const packed=await buildStoryboardBundle({namespace,chatKey:'chat',createdAt:4,entries:['storyboard','workflows','pools','characters'].map(id=>({id,file:new Blob(['{}'])}))});const proof=await createBundleCarrierProof(await openStoryboardBundle(packed.file));return {proof,head:bundleCarrierHead((await inspectBundleCarrierProof(proof)).summary)};}

test('carrier inventory counts proof wrapper plus compact index without inventing an import time or authorization',async()=>{
  const {proof,head}=await fixture(),row={key:head.key,namespace,proof},storage=summarizeBundleCarrierStorage([head],namespace);
  assert.equal(head.recordBytes,bytes(row));assert.equal(storage.recordBytes,bytes(row));assert.equal(storage.indexBytes,bytes(head));assert.equal(storage.bytes,bytes(row)+bytes(head));
  assert.equal(head.createdAt,4);assert.equal(head.identityVerified,false);assert.equal(head.restoreAuthorized,false);assert.equal(storage.count,1);
  assert.deepEqual(summarizeBundleCarrierStorage([],namespace),{version:1,namespace,count:0,recordBytes:0,indexBytes:0,bytes:0});
});
test('carrier heads reject unknown fields, mismatched namespace and dishonest byte accounting',async()=>{
  const {head}=await fixture();for(const value of [{...head,approved:true},{...head,key:'wrong'},{...head,recordBytes:head.recordBytes-1},{...head,restoreAuthorized:true},{...head,namespace:'st-user:other'}])assert.throws(()=>validateBundleCarrierHead(value,namespace));
  for(const target of ['',null,'st-user:','st-user:x\ny'])assert.throws(()=>bundleCarrierKey(target,'a'.repeat(64)));
  assert.throws(()=>bundleCarrierKey(namespace,'A'.repeat(64)));assert.throws(()=>summarizeBundleCarrierStorage([head,head],namespace));
});
test('carrier capacity caps include record and index overhead, not only source strings',async()=>{
  const {head}=await fixture(),summary={...head};delete summary.key;delete summary.recordBytes;
  const heads=Array.from({length:256},(_,index)=>bundleCarrierHead({...summary,carrierDigest:index.toString(16).padStart(64,'0')}));
  assert.equal(summarizeBundleCarrierStorage(heads,namespace).count,256);assert.throws(()=>summarizeBundleCarrierStorage([...heads,bundleCarrierHead({...summary,carrierDigest:'f'.repeat(64)})],namespace));
  assert.throws(()=>summarizeBundleCarrierStorage(heads.slice(0,8).map((row,index)=>bundleCarrierHead({...summary,carrierDigest:row.carrierDigest,bytes:4*1048576})),namespace));
  const storage=summarizeBundleCarrierStorage([head],namespace);for(const value of [{...storage,bytes:storage.bytes-1},{...storage,count:0},{...storage,extra:true},{...storage,bytes:BUNDLE_CARRIER_LIMITS.total+1}])assert.throws(()=>validateBundleCarrierStorage(value,namespace));
});
test('carrier database is lazy and closed or unconfirmed actions do not open any database',async()=>{
  const {proof}=await fixture();let opened=0;const store=createBundleCarrierStore({indexedDB:{open(){opened++;throw Error('must not open');}}});
  await assert.rejects(store.save(namespace,proof),/明确确认/);await assert.rejects(store.save(namespace,proof,{confirmed:true,isCurrent:()=>false}),/账户或页面/);
  await assert.rejects(store.list('wrong'),/目录/);store.close();await assert.rejects(store.list(namespace),/会话已结束/);assert.equal(opened,0);
});
test('malformed proof or missing original reader is rejected before carrier database access',async()=>{
  const {proof}=await fixture();let opened=0;const store=createBundleCarrierStore({indexedDB:{open(){opened++;throw Error('must not open');}}});
  await assert.rejects(store.save(namespace,{...proof,digest:'0'.repeat(64)},{confirmed:true,load:async()=>null}),/摘要/);
  await assert.rejects(store.save(namespace,proof,{confirmed:true}),/读取接口/);assert.equal(opened,0);store.close();
});
test('cancellation guard is obeyed before opening a carrier store',async()=>{
  const {proof}=await fixture();let opened=0;const store=createBundleCarrierStore({indexedDB:{open(){opened++;}}}),guard=async()=>{throw Error('cancelled');};
  await assert.rejects(store.save(namespace,proof,{confirmed:true,guard,load:async()=>null}),/cancelled/);await assert.rejects(store.load(namespace,proof.carrierDigest,{guard}),/cancelled/);await assert.rejects(store.list(namespace,{guard}),/cancelled/);assert.equal(opened,0);store.close();
});
test('synchronous account change during a member fetch stops before blob expansion even without an asynchronous guard',async()=>{
  const rows=await mappingReceiptsFixture({namespace}),captured=await captureBundleMappings({namespace,journal:{listMappingHeads:async()=>rows.map(row=>row.head),loadMappingReceipt:async(ns,kind,id)=>rows.find(row=>row.kind===kind&&row.head.digest===id).receipt}});
  const built=await buildStoryboardBundle({namespace,chatKey:'chat',createdAt:7,entries:[...['storyboard','workflows','pools','characters'].map(id=>({id,file:new Blob(['{}'])})),...captured.entries]});
  const proof=await createBundleCarrierProof(await openStoryboardBundle(built.file));let alive=true,opens=0,loads=0;
  const store=createBundleCarrierStore({indexedDB:{open(){opens++;throw Error('must not open');}}});
  class NeverRead extends Blob{arrayBuffer(){assert.fail('must not expand stale body');}}
  await assert.rejects(store.save(namespace,proof,{confirmed:true,isCurrent:()=>alive,load:async({kind,digest})=>{loads++;alive=false;return new NeverRead([JSON.stringify(rows.find(row=>row.kind===kind&&row.head.digest===digest).receipt)]);}}),/账户或页面/);
  assert.equal(loads,1);assert.equal(opens,0);store.close();
});
test('raw member inventory includes blob and wrapper/index bytes and is independently account bounded',()=>{
  const head=bundleCarrierOriginalHead(namespace,'a'.repeat(64),100),summary=summarizeBundleCarrierOriginals([head],namespace);
  assert.equal(summary.count,1);assert.equal(summary.payloadBytes,100);assert.equal(summary.recordBytes,100+bytes({key:head.key,namespace,file:null})-4);assert.equal(summary.indexBytes,bytes(head));assert.equal(summary.bytes,summary.recordBytes+summary.indexBytes);
  for(const value of [{...head,extra:true},{...head,recordBytes:99},{...head,namespace:'st-user:other'},{...head,sha256:'bad'}])assert.throws(()=>validateBundleCarrierOriginalHead(value,namespace));
  assert.throws(()=>summarizeBundleCarrierOriginals([head,head],namespace));assert.equal(summarizeBundleCarrierOriginals([],namespace).bytes,0);
});
test('raw member count and aggregate bounds include overhead and do not increase the per-record cap',()=>{
  const heads=Array.from({length:1024},(_,index)=>bundleCarrierOriginalHead(namespace,index.toString(16).padStart(64,'0'),1));assert.equal(summarizeBundleCarrierOriginals(heads,namespace).count,1024);
  assert.throws(()=>summarizeBundleCarrierOriginals([...heads,bundleCarrierOriginalHead(namespace,'f'.repeat(64),1)],namespace));
  assert.throws(()=>bundleCarrierOriginalHead(namespace,'a'.repeat(64),BUNDLE_CARRIER_ORIGINAL_LIMITS.record+1));
  assert.throws(()=>summarizeBundleCarrierOriginals(Array.from({length:8},(_,index)=>bundleCarrierOriginalHead(namespace,index.toString(16).padStart(64,'0'),9*1048576)),namespace));
});
