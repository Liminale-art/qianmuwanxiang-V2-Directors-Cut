import test from 'node:test';import assert from 'node:assert/strict';
import {mappingReceiptsFixture,namespace} from './fixtures/storyboard-mapping-receipts.mjs';
import {captureBundleMappings} from '../qianmu-bundle-mappings.js';
import {planBundleMappingRestore,restoreBundleMappings,verifyBundleMappingRestore} from '../qianmu-bundle-mapping-restore.js';
import {mappingHead} from '../qianmu-storyboard-mapping-contract.js';
import {createStoryboardEnvironmentReview} from '../qianmu-storyboard-environment-map.js';
import {bundleMappingPage,validateBundleMappingPage} from '../qianmu-bundle-mapping-contract.js';
const clone=structuredClone;
async function fixture(){
  const rows=await mappingReceiptsFixture(),source={listMappingHeads:async()=>rows.map(row=>row.head),loadMappingReceipt:async(_ns,kind,id)=>rows.find(row=>row.kind===kind&&row.head.digest===id).receipt};
  const captured=await captureBundleMappings({namespace,journal:source}),byId=new Map(captured.entries.map(row=>[row.id,row.file])),e={rows:[],writes:0};
  const journal={listMappingHeads:async()=>e.rows.map(row=>row.head),loadMappingReceipt:async(_ns,kind,id)=>clone(e.rows.find(row=>row.kind===kind&&row.head.digest===id)?.receipt||null),
    importMappingReceipt:async(receipt,{head,confirmed})=>{assert.equal(confirmed,true);if(!e.rows.some(row=>row.head.key===head.key)){e.rows.push({head:clone(head),receipt:clone(receipt),kind:head.kind});e.writes++;}return receipt;}};
  const options={index:captured.index,opened:{readJson:async id=>JSON.parse(await byId.get(id).text())},journal};return {rows,e,options,captured};
}
test('merge plan reserves both current mappings and existing history without writing or treating old approval as authorization',async()=>{
  const f=await fixture();let p=await planBundleMappingRestore(f.options);assert.equal(p.added,4);assert.equal(p.existing,0);assert.equal(p.restoreAuthorized,false);assert.equal(f.e.writes,0);
  await assert.rejects(restoreBundleMappings(f.options),/单独确认/);await restoreBundleMappings({...f.options,confirmed:true});assert.equal(f.e.writes,4);
  p=await planBundleMappingRestore(f.options);assert.equal(p.added,0);assert.equal(p.existing,4);assert.equal(p.addedBytes,0);
  await restoreBundleMappings({...f.options,confirmed:true});assert.equal(f.e.writes,4);await verifyBundleMappingRestore(f.options);
  f.e.rows.pop();await assert.rejects(verifyBundleMappingRestore(f.options),/尚未完整保存/);
});
test('capacity includes current environment receipt rather than consuming its last slot with carried history',async()=>{
  const f=await fixture(),base=f.rows[0].head;
  f.e.rows=Array.from({length:255},(_,i)=>{const id=String(i).padStart(64,'0');return {head:{...base,digest:id,key:JSON.stringify([namespace,'environment',id])},kind:'environment'};});
  assert.equal((await planBundleMappingRestore(f.options)).added,4);
  const review=await createStoryboardEnvironmentReview({...f.rows[0].receipt.review,sourceDigest:'f'.repeat(64)});
  await assert.rejects(planBundleMappingRestore({...f.options,reservations:[{kind:'environment',review}]}),/本次新映射预留/);assert.equal(f.e.writes,0);
});
test('receipt capacity is cumulative across separate valid source and destination indexes',async()=>{
  const f=await fixture(),base=f.rows[1].head;
  f.e.rows=Array.from({length:8},(_,i)=>{const id=String(i).padStart(64,'0');return {head:{...base,digest:id,key:JSON.stringify([namespace,'subjects',id]),reviewBytes:8*1048576,bytes:8*1048576+1000},kind:'subjects'};});
  await assert.rejects(planBundleMappingRestore(f.options),/总空间/);assert.equal(f.e.writes,0);
});
test('same digest with different initial timestamp is not silently deduplicated',async()=>{
  const f=await fixture(),row=clone(f.rows[0]);row.receipt.createdAt=99;row.head=mappingHead(row.kind,row.receipt);f.e.rows=[row];
  await assert.rejects(planBundleMappingRestore(f.options),/首次记录不同/);assert.equal(f.e.writes,0);assert.equal(f.e.rows[0].receipt.createdAt,99);
});
test('historic page is compact, typed and bound to the original carrier and requested offset',async()=>{
  const f=await fixture(),sourceDigest='f'.repeat(64),page=bundleMappingPage(f.captured.index,sourceDigest,{offset:0});
  assert.deepEqual(validateBundleMappingPage(page,namespace,sourceDigest,{offset:0}),page);assert.doesNotMatch(JSON.stringify(page),/lineage|sourceBindings|selections|targetEvidence/);
  for(const bad of [{...page,offset:24},{...page,sourceDigest:'e'.repeat(64)},{...page,rows:[{...page.rows[0],review:{}}]}])assert.throws(()=>validateBundleMappingPage(bad,namespace,sourceDigest,{offset:0}));
  assert.throws(()=>bundleMappingPage(f.captured.index,sourceDigest,{offset:24}));assert.throws(()=>bundleMappingPage(f.captured.index,sourceDigest,{offset:0,confirmed:true}));
  const original=f.captured.index.heads[0].createdAt;page.rows[0].createdAt=99;assert.equal(f.captured.index.heads[0].createdAt,original,'caller cannot mutate frozen restore source through a page');
});
