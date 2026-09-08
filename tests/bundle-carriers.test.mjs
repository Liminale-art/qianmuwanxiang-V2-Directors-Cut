import test from 'node:test';import assert from 'node:assert/strict';
import {carrierFixture,carrierPack,carrierFile,namespace} from './fixtures/bundle-carriers.mjs';
import {captureBundleCarriers,inspectBundleCarriers,inspectBundleCarriersIndex} from '../qianmu-bundle-carriers.js';
import {openStoryboardBundle} from '../qianmu-storyboard-bundle.js';
import {inspectBundleMappings} from '../qianmu-bundle-mappings.js';
import {createBundleCarrierProof,inspectBundleCarrierProof,verifyBundleCarrierMembers} from '../qianmu-bundle-carrier.js';
import {bundleCarrierHead,bundleCarrierOriginalHead} from '../qianmu-bundle-carrier-storage-contract.js';
import {validateBundleCarriersTransportSummary} from '../qianmu-bundle-carriers-contract.js';
import {comfyLibraryBackupDigest as digest} from '../qianmu-comfy-library-backup.js';
import {vibeDigest} from '../qianmu-vibe-file.js';
const capture=f=>captureBundleCarriers({namespace,store:f.store,mappings:f.mappings});
async function checked(entries){const built=await carrierPack(entries,30),opened=await openStoryboardBundle(built.file),mappings=await inspectBundleMappings(opened);return {built,opened,mappings,carriers:await inspectBundleCarriers(opened,{mappings})};}
async function rehash(value){const {digest:_,...core}=value;return {...core,digest:await digest(core)};}

test('equal-length legal JSON numeric spelling survives carrier transport instead of being reserialized under an old SHA',async()=>{
  const f=await carrierFixture(),old=await openStoryboardBundle((await carrierPack(f.rawEntries)).file);await inspectBundleMappings(old);
  const receipt=f.records[0],part=await old.read('mapping:environment:'+receipt.head.digest);
  assert.match(new TextDecoder().decode(part.bytes),/"createdAt":1e\+3/);assert.equal(part.bytes.length,carrierFile(receipt.receipt).size);
  await assert.rejects(verifyBundleCarrierMembers(f.proofs[0],{load:async({kind,digest})=>carrierFile(f.records.find(row=>row.kind===kind&&row.head.digest===digest).receipt)}),/分段指纹/);
  const captured=await capture(f),result=await checked([...f.mappings.entries,...captured.entries]);
  assert.equal(result.carriers.summary.count,2);assert.equal(result.carriers.summary.originalCount,4);assert.equal(result.carriers.summary.extraOriginalCount,1);
  const extra=captured.entries.find(row=>row.id.startsWith('carrier-original:'));assert.match(await extra.file.text(),/"createdAt":1e\+3/);
  assert.equal(captured.index.originals.filter(row=>row.entryId.startsWith('mapping:')).length,3);assert.equal(result.carriers.summary.restoreAuthorized,false);
  assert.deepEqual(captured.summary,result.carriers.summary);validateBundleCarriersTransportSummary(captured.summary,result.built.manifest);
});
test('standard members share mapping sections across carriers without duplicate raw segments or recursive packages',async()=>{
  const f=await carrierFixture({variant:false}),captured=await capture(f),{carriers}=await checked([...f.mappings.entries,...captured.entries]);
  assert.equal(carriers.summary.count,2);assert.equal(carriers.summary.originalCount,4);assert.equal(carriers.summary.extraOriginalCount,0);assert.equal(captured.entries.length,3);
  assert.ok(captured.entries.every(row=>row.id==='bundle-carriers'||row.id.startsWith('carrier:')));assert.ok(captured.entries.filter(row=>row.id.startsWith('carrier:')).every(row=>row.file.size<15000));
});
test('a third generation keeps historic raw variants once and reuses canonical receipts without nesting prior bundles',async()=>{
  const f=await carrierFixture(),first=await capture(f),packed=await carrierPack([...f.mappings.entries,...first.entries],40),next=await createBundleCarrierProof(await openStoryboardBundle(packed.file));
  f.proofs.push(next);f.heads.push(bundleCarrierHead((await inspectBundleCarrierProof(next)).summary));
  for(const entry of f.mappings.entries.filter(row=>row.id!=='mapping-receipts')){const sha=await vibeDigest(new Uint8Array(await entry.file.arrayBuffer()));if(!f.rawFiles.has(sha)){f.rawFiles.set(sha,entry.file);f.originals.push(bundleCarrierOriginalHead(namespace,sha,entry.file.size));}}
  const captured=await capture(f),{carriers}=await checked([...f.mappings.entries,...captured.entries]);assert.equal(carriers.summary.count,3);assert.equal(carriers.summary.originalCount,5);assert.equal(carriers.summary.extraOriginalCount,1);
  assert.equal(captured.entries.filter(row=>row.id.startsWith('carrier-original:')).length,1);assert.ok(captured.index.heads.some(row=>row.carrierDigest===packed.fingerprint));
  f.heads.shift();await assert.rejects(capture(f),/旧载体来源缺失/);
});
test('missing intermediate carrier declarations cannot be hidden by rewriting the new directory',async()=>{
  const f=await carrierFixture({variant:false}),initial=await capture(f),packed=await carrierPack([...f.mappings.entries,...initial.entries],41),proof=await createBundleCarrierProof(await openStoryboardBundle(packed.file));
  f.proofs.push(proof);f.heads.push(bundleCarrierHead((await inspectBundleCarrierProof(proof)).summary));
  const captured=await capture(f),lost=captured.index.heads[0],index=await rehash({...captured.index,heads:captured.index.heads.filter(row=>row!==lost)});
  const entries=captured.entries.filter(row=>row.id!=='carrier:'+lost.carrierDigest).map(row=>row.id==='bundle-carriers'?{...row,file:carrierFile(index)}:row);
  await assert.rejects(checked([...f.mappings.entries,...entries]),/旧载体来源缺失/);
});
test('old missing carrier directory and a newly explicit empty directory remain distinct',async()=>{
  const old=await openStoryboardBundle((await carrierPack()).file);assert.equal(await inspectBundleCarriers(old),null);
  const f=await carrierFixture();f.heads.length=0;f.originals.length=0;const captured=await capture(f),result=await checked([...f.mappings.entries,...captured.entries]);
  assert.equal(result.carriers.summary.count,0);assert.equal(result.carriers.summary.originalCount,0);assert.equal(result.carriers.summary.recorded,true);
});
test('missing originals, missing canonical journal members and changed proof bodies stop export',async()=>{
  const f=await carrierFixture();await assert.rejects(captureBundleCarriers({namespace,store:{...f.store,loadOriginal:async()=>null},mappings:f.mappings}),/缺失/);
  await assert.rejects(captureBundleCarriers({namespace,store:f.store,mappings:{...f.mappings,index:{...f.mappings.index,heads:[]}}}),/缺少同一/);
  await assert.rejects(captureBundleCarriers({namespace,store:{...f.store,load:async()=>({...f.proofs[0],manifestText:'{}'})},mappings:f.mappings}));
});
test('carrier snapshot detects additions and cancellations without silently dropping late history',async()=>{
  const f=await carrierFixture();let reads=0;
  const store={...f.store,list:async()=>{const value=await f.store.list();if(++reads>1)value.heads=[];return value;}};
  await assert.rejects(captureBundleCarriers({namespace,store,mappings:f.mappings}),/已变化/);
  let alive=true;await assert.rejects(captureBundleCarriers({namespace,mappings:f.mappings,isCurrent:()=>alive,store:{...f.store,loadOriginal:async(...args)=>{alive=false;return f.store.loadOriginal(...args);}}}),/已变化/);
});
test('carrier directory refuses wrong accounts, duplicate originals, reordered proofs, forged index digest and added authority',async()=>{
  const f=await carrierFixture(),{index}=await capture(f);
  for(const value of [{...index,namespace:'st-user:other'},{...index,heads:[...index.heads].reverse()},{...index,originals:[...index.originals,index.originals[0]]},{...index,approved:true},{...index,digest:'0'.repeat(64)}])await assert.rejects(inspectBundleCarriersIndex(value,namespace));
  await assert.rejects(inspectBundleCarriersIndex(await rehash({...index,originals:index.originals.map((row,i)=>i?row:{...row,entryId:'image:'+row.sha256})}),namespace));
});
test('absent, extra and spliced transport sections fail full carrier inspection',async()=>{
  const f=await carrierFixture(),captured=await capture(f),parts=[...f.mappings.entries,...captured.entries],proofIndex=parts.findIndex(row=>row.id.startsWith('carrier:'));
  await assert.rejects(checked(parts.filter((_,index)=>index!==proofIndex)),/缺失或多余/);
  const other=f.proofs.find(proof=>parts[proofIndex].id!=='carrier:'+proof.carrierDigest);
  await assert.rejects(checked(parts.map((row,index)=>index===proofIndex?{...row,file:carrierFile(other)}:row)),/清单不符/);
  await assert.rejects(checked(parts.filter(row=>!row.id.startsWith('carrier-original:'))),/缺失或多余/);
});
test('main-thread summary cannot omit provenance or invent transported bytes and body counts',async()=>{
  const f=await carrierFixture(),captured=await capture(f),{built}=await checked([...f.mappings.entries,...captured.entries]);
  for(const value of [undefined,{...captured.summary,restoreAuthorized:true},{...captured.summary,count:3},{...captured.summary,extraOriginalBytes:0},{...captured.summary,proofBytes:1}])assert.throws(()=>validateBundleCarriersTransportSummary(value,built.manifest));
});
test('carrier metadata expansion preserves the image cap and raw-origin content-addressed identity checks',async()=>{
  const entries=Array.from({length:1025},(_,i)=>({id:'image:'+i.toString(16).padStart(64,'0'),mime:'image/png',file:new Blob(['x'])}));
  await assert.rejects(carrierPack(entries),/原件或迁移凭据数量/);
  await assert.rejects(carrierPack([{id:'bundle-carriers',file:carrierFile({})},{id:'carrier-original:'+'0'.repeat(64),file:carrierFile({})}]),/原文指纹/);
});

test('many carriers verify unique originals once instead of expanding each full receipt per proof',async()=>{
  const f=await carrierFixture();for(let i=0;i<24;i++){const proof=await createBundleCarrierProof(await openStoryboardBundle((await carrierPack(f.rawEntries,100+i)).file));f.proofs.push(proof);f.heads.push(bundleCarrierHead((await inspectBundleCarrierProof(proof)).summary));}
  const original=Blob.prototype.arrayBuffer;let reads=0,captured;Blob.prototype.arrayBuffer=function(...args){reads++;return original.apply(this,args);};
  try{captured=await capture(f);}finally{Blob.prototype.arrayBuffer=original;}assert.equal(reads,8,'four canonical hashes and four complete originals, independent of 26 proofs');
  const opened=await openStoryboardBundle((await carrierPack([...f.mappings.entries,...captured.entries],77)).file),mappings=await inspectBundleMappings(opened);
  reads=0;Blob.prototype.arrayBuffer=function(...args){reads++;return original.apply(this,args);};
  try{await inspectBundleCarriers(opened,{mappings});}finally{Blob.prototype.arrayBuffer=original;}assert.equal(reads,35,'26 proof segments, one index and two bounded reads per unique original');
});

test('a valid raw member cannot authorize changed metadata inside another otherwise coherent carrier proof',async()=>{
  const f=await carrierFixture(),captured=await capture(f),old=f.proofs[0],mappingIndex=JSON.parse(old.mappingIndexText);mappingIndex.heads[0].createdAt++;
  const indexText=JSON.stringify(await rehash(mappingIndex)),manifest=JSON.parse(old.manifestText),entry=manifest.entries.find(row=>row.id==='mapping-receipts');entry.sha256=await vibeDigest(new TextEncoder().encode(indexText));entry.bytes=new Blob([indexText]).size;
  const manifestText=JSON.stringify(manifest),forged=await rehash({...old,manifestText,mappingIndexText:indexText,carrierDigest:await vibeDigest(new TextEncoder().encode(manifestText))}),head=bundleCarrierHead((await inspectBundleCarrierProof(forged)).summary);
  f.proofs[0]=forged;f.heads[0]=head;await assert.rejects(capture(f),/与原目录不符/);
  const index=await rehash({...captured.index,heads:captured.index.heads.map(row=>row.carrierDigest===old.carrierDigest?head:row).sort((a,b)=>a.carrierDigest<b.carrierDigest?-1:1)});
  const entries=captured.entries.map(row=>row.id==='bundle-carriers'?{...row,file:carrierFile(index)}:row.id==='carrier:'+old.carrierDigest?{id:'carrier:'+head.carrierDigest,file:carrierFile(forged)}:row);
  await assert.rejects(checked([...f.mappings.entries,...entries]),/与原目录不符/);
});

test('a canonical mapping segment cannot stand in for a missing declared original during unique-member checks',async()=>{
  const f=await carrierFixture({variant:false}),captured=await capture(f);f.originals.pop();await assert.rejects(capture(f),/原文缺失/);
  const index=await rehash({...captured.index,originals:captured.index.originals.slice(1)}),entries=captured.entries.map(row=>row.id==='bundle-carriers'?{...row,file:carrierFile(index)}:row);
  await assert.rejects(checked([...f.mappings.entries,...entries]),/原文缺失/);
});

test('unique-member verification is local to one operation and never reuses a prior source read after corruption',async()=>{
  const f=await carrierFixture();await capture(f);const head=f.originals[0],text=await f.rawFiles.get(head.sha256).text();f.rawFiles.set(head.sha256,new Blob([text.replace('"createdAt":','"createdXs":')]));
  await assert.rejects(capture(f),/指纹不符/);
});
