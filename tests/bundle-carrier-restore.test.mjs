import test from 'node:test';import assert from 'node:assert/strict';
import {carrierFixture,carrierPack,namespace,memoryCarrierStore} from './fixtures/bundle-carriers.mjs';
import {captureBundleCarriers} from '../qianmu-bundle-carriers.js';
import {openStoryboardBundle} from '../qianmu-storyboard-bundle.js';
import {createBundleCarrierRestore} from '../qianmu-bundle-carrier-restore.js';
import {validateBundleCarrierRestoreSummary,validateBundleCarrierPage} from '../qianmu-bundle-carrier-restore-contract.js';
import {bundleCarrierHead,bundleCarrierOriginalHead,bundleCarrierInventory,validateBundleCarrierInventory} from '../qianmu-bundle-carrier-storage-contract.js';
import {createBundleCarrierProof,inspectBundleCarrierProof} from '../qianmu-bundle-carrier.js';
import {collectStoryboardCarrierStorage} from '../qianmu-storyboard-restore-storage-runtime.js';
import {renderStoryboardBundleReview} from '../qianmu-storyboard-bundle-view.js';
async function fixture({orphan=false}={}){
  const source=await carrierFixture();if(orphan){source.heads.length=0;source.proofs.length=0;}
  const captured=await captureBundleCarriers({namespace,store:source.store,mappings:source.mappings}),built=await carrierPack([...source.mappings.entries,...captured.entries],77),opened=await openStoryboardBundle(built.file),target=memoryCarrierStore();
  const options={opened,store:target.store},reopen=()=>createBundleCarrierRestore(options);return {source,opened,target,options,reopen,session:await reopen()};
}
test('source plan reserves current carrier and exact raw variants, requires fresh consent and reuses immutable records',async()=>{
  const f=await fixture(),p=await f.session.preview();assert.equal(p.count,3);assert.equal(p.added,3);assert.equal(p.originalCount,5);assert.equal(p.addedOriginals,5);assert.equal(p.restoreAuthorized,false);assert.equal(f.target.state.events.length,0);
  await assert.rejects(f.session.restore(p),/单独确认/);await f.session.restore(p,{confirmed:true});assert.deepEqual(f.target.state.events,['raw','raw','raw','raw','raw','proof','proof','proof']);await f.session.verify();
  const reopened=await f.reopen(),again=await reopened.preview();assert.equal(again.added,0);assert.equal(again.addedOriginals,0);assert.equal(again.addedBytes,0);await assert.rejects(reopened.restore(again),/单独确认/);await reopened.restore(again,{confirmed:true});assert.equal(f.target.state.events.length,8);
});
test('standalone retained raw variants are restored even when old proof records are no longer referenced',async()=>{
  const f=await fixture({orphan:true}),p=await f.session.preview();assert.equal(p.count,1);assert.equal(p.originalCount,5);await f.session.restore(p,{confirmed:true});assert.equal(f.target.state.originals.length,5);assert.equal(f.target.state.heads.length,1);
});
test('partial original and proof writes remain inspectable and reopen only completes missing data with new confirmation',async()=>{
  const f=await fixture();f.target.state.failRawAt=2;await assert.rejects(f.session.restore(await f.session.preview(),{confirmed:true}),/raw interrupted/);assert.equal(f.target.state.heads.length,0);assert.equal(f.target.state.originals.length,2);
  delete f.target.state.failRawAt;f.target.state.failProofAt=1;const second=await f.reopen();await assert.rejects(second.restore(await second.preview(),{confirmed:true}),/proof interrupted/);assert.equal(f.target.state.originals.length,5);assert.equal(f.target.state.heads.length,1);
  delete f.target.state.failProofAt;const third=await f.reopen(),p=await third.preview();assert.equal(p.added,2);assert.equal(p.addedOriginals,0);await third.restore(p,{confirmed:true});assert.equal(f.target.state.events.length,8);
});
test('capacity combines existing destination and source plus this carrier before any writes',async()=>{
  const f=await fixture(),sourceHead=f.source.heads[0],{key,recordBytes,...base}=sourceHead;
  for(let i=0;i<254;i++){const id=i.toString(16).padStart(64,'0'),head=bundleCarrierHead({...base,carrierDigest:id});f.target.state.heads.push(head);f.target.state.proofs.set(id,{});}
  await assert.rejects(f.session.preview(),/含本次载体/);assert.equal(f.target.state.events.length,0);
  f.target.state.heads.length=0;f.target.state.proofs.clear();for(let i=0;i<8;i++){const head=bundleCarrierOriginalHead(namespace,i.toString(16).padStart(64,'0'),9*1048576-1024);f.target.state.originals.push(head);f.target.state.files.set(head.sha256,new Blob(['synthetic head-only boundary']));}
  await assert.rejects(f.session.preview(),/超限|总空间/);assert.equal(f.target.state.events.length,0);
});
test('an unrelated destination edit invalidates approval while corrupt matching originals cannot be replaced',async()=>{
  const f=await fixture(),approved=await f.session.preview(),other=await createBundleCarrierProof(await openStoryboardBundle((await carrierPack([],101)).file));
  await f.target.store.save(namespace,other,{confirmed:true,load:async()=>null});await assert.rejects(f.session.restore(approved,{confirmed:true}),/确认后来源库已变化/);assert.equal(f.target.state.events.filter(row=>row==='raw').length,0);
  const p=await f.session.preview();await f.session.restore(p,{confirmed:true});const head=f.target.state.originals[0];f.target.state.files.set(head.sha256,new Blob(['wrong']));await assert.rejects(f.session.preview(),/original changed/);
});
test('stage verification rejects missing proof or member heads rather than falsely authorizing later resources',async()=>{
  const f=await fixture();await f.session.restore(await f.session.preview(),{confirmed:true});const removed=f.target.state.heads.pop();await assert.rejects(f.session.verify(),/尚未完整保存/);f.target.state.heads.push(removed);f.target.state.originals.pop();await assert.rejects(f.session.verify(),/尚未完整保存/);
});
test('source pages contain only compact heads, include current carrier first, and cannot mutate the source descriptor',async()=>{
  const f=await fixture(),p=await f.session.preview(),page=await f.session.page({offset:0});validateBundleCarrierPage(page,namespace,f.opened.fingerprint,{offset:0});assert.equal(page.rows[0].current,true);assert.equal(page.descriptorDigest,p.descriptorDigest);assert.equal(page.total,3);assert.doesNotMatch(JSON.stringify(page),/manifestText|mappingIndexText|sourceBindings|"file":/);
  page.rows[0].digest='0'.repeat(64);assert.notEqual((await f.session.page({offset:0})).rows[0].digest,page.rows[0].digest);await assert.rejects(f.session.page({offset:24}),/已变化/);
  assert.throws(()=>validateBundleCarrierRestoreSummary({...p,restoreAuthorized:true},namespace,f.opened.fingerprint));assert.throws(()=>validateBundleCarrierPage({...page,total:257},namespace,f.opened.fingerprint,{offset:0}));
  assert.throws(()=>validateBundleCarrierPage({...page,rows:[page.rows[1],page.rows[0],page.rows[2]]},namespace,f.opened.fingerprint,{offset:0}));
  assert.throws(()=>validateBundleCarrierPage({...page,offset:24,total:25,rows:[page.rows[0]]},namespace,f.opened.fingerprint,{offset:24}));
});
test('carrier inventory counts separate proof and raw archives, preserves unavailability and stops on namespace changes',async()=>{
  const f=await fixture();await f.session.restore(await f.session.preview(),{confirmed:true});const summary=bundleCarrierInventory(await f.target.store.list(),namespace);assert.equal(summary.count,3);assert.equal(summary.originalCount,5);assert.equal(summary.bytes,summary.proofBytes+summary.originalBytes);
  assert.throws(()=>validateBundleCarrierInventory({...summary,bytes:0},namespace));assert.deepEqual(await collectStoryboardCarrierStorage({resolveNamespace:async()=>namespace,call:async()=>summary}),summary);
  const unavailable=await collectStoryboardCarrierStorage({resolveNamespace:async()=>namespace,call:async()=>{throw Error('unavailable');}});assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.bytes,null);
  let current=namespace;await assert.rejects(collectStoryboardCarrierStorage({resolveNamespace:async()=>current,call:async()=>{current='st-user:other';return summary;}}),/账户已变化/);
});
test('restore UI requires independent source consent and shows logical capacity without exposing stored bodies',async()=>{
  const f=await fixture(),plan=await f.session.preview(),preview={ready:true,planDigest:'a'.repeat(64),conflicts:[],bindingReview:[],images:[],summary:{images:0,vibeFiles:0,workflows:{count:0,versions:0},pools:{count:0},characters:{count:0}},characterSummary:{added:0,replaced:0,kept:0},carrierRestore:plan};
  const view={preview,page:0,busy:false,environmentReviewed:true},html=renderStoryboardBundleReview(view);assert.match(html,/data-bundle-carriers-reviewed/);assert.match(html,/data-bundle-action="restore" disabled/);assert.match(html,/含本次备份/);
  assert.doesNotMatch(renderStoryboardBundleReview({...view,carriersReviewed:true}),/data-bundle-action="restore" disabled/);
});

test('restoration requires the store-owned batch path and passes old sources before the current carrier',async()=>{
  const f=await fixture(),{saveBatch,...withoutBatch}=f.target.store;await assert.rejects(createBundleCarrierRestore({...f.options,store:withoutBatch}),/存储不可用/);
  let calls=0;f.target.store.saveBatch=async function(ns,input,options){calls++;assert.equal(options.confirmed,true);assert.equal(input.heads.at(-1).carrierDigest,f.opened.fingerprint);assert.equal(input.originals.length,5);return saveBatch.call(this,ns,input,options);};
  await f.session.restore(await f.session.preview(),{confirmed:true});assert.equal(calls,1);assert.equal(f.target.state.events.length,8);
});
