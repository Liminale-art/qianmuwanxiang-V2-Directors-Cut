import test from 'node:test';
import assert from 'node:assert/strict';
import {mappingReceiptsFixture,namespace} from './fixtures/storyboard-mapping-receipts.mjs';
import {captureBundleMappings,inspectBundleMappings,inspectBundleMappingIndex,inspectBundleMappingReceipt} from '../qianmu-bundle-mappings.js';
import {BUNDLE_MAPPING_LIMITS,bundleMappingEntryId,validateBundleMappingHeads,validateBundleMappingSummary,validateBundleMappingTransportSummary} from '../qianmu-bundle-mapping-contract.js';
import {mappingBytes,mappingHead} from '../qianmu-storyboard-mapping-contract.js';
import {buildStoryboardBundle,openStoryboardBundle} from '../qianmu-storyboard-bundle.js';
import {comfyLibraryBackupDigest as digest} from '../qianmu-comfy-library-backup.js';
const clone=structuredClone,file=value=>new Blob([JSON.stringify(value)],{type:'application/json'});
async function fixture(){
  const rows=await mappingReceiptsFixture(),e={rows,reads:0,lists:0,current:true};
  const journal={listMappingHeads:async ns=>{assert.equal(ns,namespace);e.lists++;e.onList?.();return clone(e.rows.map(row=>row.head));},loadMappingReceipt:async(ns,kind,id)=>{
    assert.equal(ns,namespace);e.reads++;e.onRead?.();return clone(e.rows.find(row=>row.kind===kind&&row.receipt.review.digest===id)?.receipt||null);
  }};
  const options={namespace,journal,isCurrent:()=>e.current};return {e,options,capture:()=>captureBundleMappings(options)};
}
async function pack(parts){return buildStoryboardBundle({namespace,chatKey:'new-backup-chat',createdAt:88,entries:[...['storyboard','workflows','pools','characters'].map(id=>({id,file:file({})})),...parts]});}
async function rehash(index){const {digest:_,...core}=index;return {...core,digest:await digest(core)};}

test('transport carries all four original receipt kinds, full lineage and first timestamps without authorizing reuse',async()=>{
  const f=await fixture(),before=clone(f.e.rows),captured=await f.capture(),built=await pack(captured.entries),opened=await openStoryboardBundle(built.file),checked=await inspectBundleMappings(opened);
  assert.equal(captured.summary.count,4);assert.equal(captured.summary.environment,1);assert.equal(captured.summary.subjects,3);assert.equal(captured.summary.restoreAuthorized,false);
  assert.equal(captured.summary.bytes,before.reduce((sum,row)=>sum+mappingBytes(row.receipt),0));assert.deepEqual(checked.summary,captured.summary);assert.deepEqual(f.e.rows,before);
  for(const row of before){const receipt=await opened.readJson(bundleMappingEntryId(row.head));assert.deepEqual(receipt,row.receipt);assert.notEqual(receipt.review.sourceDigest,built.fingerprint);assert.notEqual(receipt.review.chatHash,await digest('new-backup-chat'));}
  assert.deepEqual(checked.index.heads.map(row=>row.version).sort(),[1,1,2,3]);assert.equal(f.e.reads,4);assert.equal(f.e.lists,2);
  assert.ok(captured.entries.every(row=>row.file instanceof Blob));assert.doesNotMatch(JSON.stringify(captured.summary),/lineage|selections|projection|targetEvidence|sourceBindings/);
});

test('an empty recorded journal is distinct from an old package with no receipt directory',async()=>{
  const f=await fixture();f.e.rows=[];const captured=await f.capture(),checked=await inspectBundleMappings(await openStoryboardBundle((await pack(captured.entries)).file));
  assert.equal(checked.summary.count,0);assert.equal(checked.summary.recorded,true);assert.equal(checked.summary.bytes,0);assert.equal(captured.entries.length,1);assert.equal(f.e.reads,0);
  assert.equal(await inspectBundleMappings(await openStoryboardBundle((await pack([])).file)),null);
  assert.throws(()=>validateBundleMappingSummary({...captured.summary,restoreAuthorized:true}));assert.throws(()=>validateBundleMappingSummary({...captured.summary,history:{}}));
});

test('receipt snapshot rejects additions, missing originals, changed directory timestamps and account closure',async()=>{
  const f=await fixture(),captured=await f.capture();f.e.rows.pop();await assert.rejects(captured.verify(),/已变化/);
  const missing=await fixture();missing.options.journal.loadMappingReceipt=async()=>null;await assert.rejects(missing.capture(),/缺失/);
  const changed=await fixture();changed.e.onRead=()=>{changed.e.rows[0].receipt.createdAt++;};await assert.rejects(changed.capture(),/目录不符/);
  const late=await fixture();late.e.onRead=()=>{late.e.current=false;};await assert.rejects(late.capture(),/页面已变化/);
  const lateList=await fixture();lateList.e.onList=()=>{if(lateList.e.lists===2)lateList.e.rows.pop();};await assert.rejects(lateList.capture(),/已变化/);
});

test('directory validates sort, unique kind and digest, namespace, exact fields, count and aggregate before body reads',async()=>{
  const f=await fixture(),captured=await f.capture();
  for(const changed of [{...captured.index,heads:[...captured.index.heads].reverse()},{...captured.index,heads:[captured.index.heads[0],captured.index.heads[0]]},{...captured.index,namespace:'st-user:alien'},{...captured.index,scope:'confirmed'},{...captured.index,approved:true}])await assert.rejects(inspectBundleMappingIndex(await rehash(changed),namespace));
  await assert.rejects(inspectBundleMappingIndex({...captured.index,digest:'0'.repeat(64)},namespace),/摘要/);
  const h=f.e.rows[1].head,large=Array.from({length:9},(_,i)=>{const id=String(i).padStart(64,'0');return {...h,digest:id,key:JSON.stringify([namespace,'subjects',id]),reviewBytes:8*1048576,bytes:8*1048576+1000};});
  assert.throws(()=>validateBundleMappingHeads(large,namespace));
  const tooMany=Array.from({length:257},(_,i)=>{const id=String(i).padStart(64,'0');return {...h,digest:id,key:JSON.stringify([namespace,'subjects',id])};});
  f.e.rows=tooMany.map(head=>({head}));await assert.rejects(f.capture());assert.equal(f.e.reads,4);
});

test('valid transport hashes cannot hide forged full proofs, unknown payloads or rewritten original timestamps',async()=>{
  const f=await fixture();
  for(const row of f.e.rows){
    const changed=clone(row.receipt);changed.review.digest='0'.repeat(64);await assert.rejects(inspectBundleMappingReceipt(changed,row.head,namespace));
    await assert.rejects(inspectBundleMappingReceipt({...row.receipt,approved:true},row.head,namespace));
    await assert.rejects(inspectBundleMappingReceipt({...row.receipt,createdAt:999},row.head,namespace),/目录不符/);
    await assert.rejects(inspectBundleMappingReceipt(row.receipt,row.head,'st-user:alien'));
  }
  const row=f.e.rows[3],forged=clone(row.receipt);forged.review.projection.sourceBindings[0].archiveId='forged';
  forged.bytes=mappingBytes(forged.review);forged.key=JSON.stringify([namespace,forged.review.digest,forged.bytes]);const head=mappingHead(row.kind,forged);
  await assert.rejects(inspectBundleMappingReceipt(forged,head,namespace));
});

test('entry census rejects absent, extra and mismatched receipt segments rather than ignoring them',async()=>{
  const f=await fixture(),captured=await f.capture();
  const missing=await pack(captured.entries.slice(0,-1));await assert.rejects(inspectBundleMappings(await openStoryboardBundle(missing.file)),/缺失/);
  await assert.rejects(pack(captured.entries.slice(1)),/缺少清单/);
  await assert.rejects(pack([...captured.entries,captured.entries[1]]),/身份/);
  const extraId=`mapping:subjects:${'f'.repeat(64)}`,extra=await pack([...captured.entries,{id:extraId,file:file({})}]);await assert.rejects(inspectBundleMappings(await openStoryboardBundle(extra.file)),/多余/);
  const changed=await pack(captured.entries.map((row,i)=>i===1?{...row,file:file({})}:row));await assert.rejects(inspectBundleMappings(await openStoryboardBundle(changed.file)),/大小/);
  await assert.rejects(pack([{id:'mapping:mutations:'+ 'f'.repeat(64),file:file({})}]),/身份/);
});

test('binary reading stays per-receipt and rejects oversized segments before reading bodies',async()=>{
  const f=await fixture(),captured=await f.capture(),built=await pack(captured.entries);let reads=[];
  class SliceOnly extends Blob{arrayBuffer(){assert.fail('whole package read');}slice(a,b,mime){reads.push(b-a);return super.slice(a,b,mime);}}
  const opened=await openStoryboardBundle(new SliceOnly([built.file]));await inspectBundleMappings(opened);
  assert.ok(reads.length>4);assert.ok(reads.every(bytes=>bytes<built.file.size));
  class Oversized extends Blob{get size(){return BUNDLE_MAPPING_LIMITS.receipt+1;}arrayBuffer(){assert.fail('oversized body read');}}
  await assert.rejects(pack(captured.entries.map((row,i)=>i===1?{...row,file:new Oversized(['{}'])}:row)),/大小/);
});

test('lightweight RPC summary cannot omit carried history or invent its counts',async()=>{
  const f=await fixture(),captured=await f.capture(),built=await pack(captured.entries);
  validateBundleMappingTransportSummary(captured.summary,built.manifest);
  assert.throws(()=>validateBundleMappingTransportSummary(undefined,built.manifest));
  assert.throws(()=>validateBundleMappingTransportSummary(captured.summary,{entries:[]}));
  assert.throws(()=>validateBundleMappingTransportSummary({...captured.summary,bytes:captured.summary.bytes+1},built.manifest));
  assert.throws(()=>validateBundleMappingTransportSummary({...captured.summary,subjects:2,environment:2},built.manifest));
  validateBundleMappingTransportSummary(undefined,(await pack([])).manifest);
});

test('larger mapping entry budget does not silently raise the original 1024-image cap',async()=>{
  class NeverRead extends Blob{arrayBuffer(){assert.fail('image limit must fail before reading');}}
  const images=Array.from({length:1025},(_,i)=>({id:'image:'+String(i).padStart(64,'0'),mime:'image/png',file:new NeverRead(['x'])}));
  await assert.rejects(pack(images),/原件或迁移凭据数量超限/);
});
