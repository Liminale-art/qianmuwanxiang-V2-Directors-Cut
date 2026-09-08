import test from 'node:test';import assert from 'node:assert/strict';
import {mappingReceiptsFixture,namespace} from './fixtures/storyboard-mapping-receipts.mjs';
import {captureBundleMappings} from '../qianmu-bundle-mappings.js';
import {buildStoryboardBundle,openStoryboardBundle,inspectStoryboardBundleManifestText} from '../qianmu-storyboard-bundle.js';
import {createBundleCarrierProof,inspectBundleCarrierProof,verifyBundleCarrierMembers} from '../qianmu-bundle-carrier.js';
import {validateBundleCarrierSummary,BUNDLE_CARRIER_LIMITS} from '../qianmu-bundle-carrier-contract.js';
import {comfyLibraryBackupDigest as digest} from '../qianmu-comfy-library-backup.js';
import {vibeDigest} from '../qianmu-vibe-file.js';
const file=value=>new Blob([JSON.stringify(value)],{type:'application/json'}),clone=structuredClone;
async function pack(entries=[]){return buildStoryboardBundle({namespace,chatKey:'carrier-chat',createdAt:321,entries:[...['storyboard','workflows','pools','characters'].map(id=>({id,file:file({})})),...entries]});}
async function fixture({empty=false}={}){
  const rows=empty?[]:await mappingReceiptsFixture(),journal={listMappingHeads:async()=>rows.map(row=>row.head),loadMappingReceipt:async(_ns,kind,id)=>rows.find(row=>row.kind===kind&&row.head.digest===id).receipt};
  const captured=await captureBundleMappings({namespace,journal}),built=await pack(captured.entries),opened=await openStoryboardBundle(built.file),proof=await createBundleCarrierProof(opened);
  const load=async({kind,digest})=>file(rows.find(row=>row.kind===kind&&row.head.digest===digest).receipt);return {rows,captured,built,opened,proof,load};
}
async function rehash(value){const {digest:_,...core}=value;return {...core,digest:await digest(core)};}

test('carrier proves original manifest membership without embedding receipts, pictures or authorizing any restore',async()=>{
  const f=await fixture(),before=clone(f.rows),checked=await inspectBundleCarrierProof(f.proof);
  assert.equal(checked.summary.carrierDigest,f.built.fingerprint);assert.equal(checked.summary.createdAt,321);assert.equal(checked.summary.fileBytes,f.built.file.size);assert.equal(checked.summary.receiptCount,4);
  assert.equal(checked.summary.identityVerified,false);assert.equal(checked.summary.restoreAuthorized,false);assert.equal(checked.summary.indexState,'recorded');assert.deepEqual(f.rows,before);
  assert.equal(f.proof.manifestText,f.opened.manifestText);assert.equal(await vibeDigest(f.proof.manifestText),f.built.fingerprint);
  assert.deepEqual(await verifyBundleCarrierMembers(f.proof,{load:f.load}),checked.summary);
  assert.ok(checked.members.some(row=>row.head.version===2));assert.ok(checked.members.some(row=>row.head.version===3));
  assert.equal(checked.members.find(row=>row.head.version===2).originKind,'binding-snapshot');assert.ok(checked.members.filter(row=>row.head.version!==2).every(row=>row.originKind==='declared-bundle'));
  assert.doesNotMatch(JSON.stringify(f.proof),/sourceBindings|lineage|selections|targetEvidence|private appearance|imagegen|apiKey/);
  assert.deepEqual(await createBundleCarrierProof(f.opened),f.proof,'deterministic proof has no new import timestamp');
});

test('missing history in an old manifest never becomes an explicitly empty history',async()=>{
  const old=await openStoryboardBundle((await pack()).file),proof=await createBundleCarrierProof(old),summary=(await inspectBundleCarrierProof(proof)).summary;
  assert.equal(proof.mappingIndexText,null);assert.equal(summary.indexState,'absent');assert.equal(summary.receiptCount,0);
  const empty=await fixture({empty:true});assert.equal((await inspectBundleCarrierProof(empty.proof)).summary.indexState,'empty');
  await assert.rejects(inspectBundleCarrierProof(await rehash({...proof,mappingIndexText:empty.proof.mappingIndexText})),/存在状态/);
  await assert.rejects(inspectBundleCarrierProof(await rehash({...empty.proof,mappingIndexText:null})),/存在状态/);
});

test('exact noncanonical manifest whitespace is preserved rather than reserialized under a false old fingerprint',async()=>{
  const f=await fixture(),magic=new TextEncoder().encode('QIANMU-BUNDLE/1\n'),oldPrefix=magic.length+4,oldHeader=new Uint8Array(await f.built.file.slice(0,oldPrefix).arrayBuffer()),oldLength=new DataView(oldHeader.buffer).getUint32(magic.length,true);
  const raw=JSON.stringify(f.built.manifest,null,2)+'\n',encoded=new TextEncoder().encode(raw),length=new Uint8Array(4);new DataView(length.buffer).setUint32(0,encoded.length,true);
  const altered=new Blob([magic,length,encoded,f.built.file.slice(oldPrefix+oldLength)]),opened=await openStoryboardBundle(altered),proof=await createBundleCarrierProof(opened);
  assert.equal(proof.manifestText,raw);assert.notEqual(proof.carrierDigest,f.proof.carrierDigest);assert.equal(proof.carrierDigest,await vibeDigest(raw));
  assert.deepEqual(JSON.parse(proof.manifestText),f.built.manifest);assert.equal((await verifyBundleCarrierMembers(proof,{load:f.load})).receiptCount,4);
  await assert.rejects(inspectBundleCarrierProof(await rehash({...proof,manifestText:JSON.stringify(opened.manifest)})),/原包指纹/);
  assert.equal((await inspectStoryboardBundleManifestText(raw)).fileBytes,altered.size);
});

test('rewriting carrier namespace, fingerprint, scope, unknown approvals or internal digest is rejected',async()=>{
  const f=await fixture();
  for(const value of [{...f.proof,namespace:'st-user:alien'},{...f.proof,carrierDigest:'0'.repeat(64)},{...f.proof,scope:'verified-identity'},{...f.proof,approved:true},{...f.proof,receipt:{}}])await assert.rejects(inspectBundleCarrierProof(await rehash(value)));
  await assert.rejects(inspectBundleCarrierProof({...f.proof,digest:'f'.repeat(64)}),/摘要不符/);
  await assert.rejects(inspectBundleCarrierProof(f.proof,{namespace:'st-user:other'}));
  const {summary}=await inspectBundleCarrierProof(f.proof);assert.throws(()=>validateBundleCarrierSummary({...summary,identityVerified:true},namespace));assert.throws(()=>validateBundleCarrierSummary({...summary,indexState:'empty'},namespace));
});

test('a rehashed proof cannot splice another valid receipt index onto the original carrier manifest',async()=>{
  const f=await fixture(),empty=await fixture({empty:true});
  await assert.rejects(inspectBundleCarrierProof(await rehash({...f.proof,mappingIndexText:empty.proof.mappingIndexText})),/不属于此原包/);
  await assert.rejects(inspectBundleCarrierProof(await rehash({...f.proof,mappingIndexText:f.proof.mappingIndexText+' '})),/不属于此原包/);
});

test('membership validation needs exact full original receipt bytes, not only a matching review digest or directory',async()=>{
  const f=await fixture();await assert.rejects(verifyBundleCarrierMembers(f.proof,{load:async()=>null}),/缺少完整/);
  await assert.rejects(verifyBundleCarrierMembers(f.proof,{load:async target=>{const row=f.rows.find(row=>row.kind===target.kind&&row.head.digest===target.digest);return file({...row.receipt,createdAt:8});}}),/缺少完整|分段指纹/);
  const load=async target=>{const row=f.rows.find(row=>row.kind===target.kind&&row.head.digest===target.digest),text=JSON.stringify(row.receipt).replace('"createdAt":'+row.receipt.createdAt,'"createdAt":8');return new Blob([text]);};
  await assert.rejects(verifyBundleCarrierMembers(f.proof,{load}),/分段指纹/);
  assert.equal((await inspectBundleCarrierProof(f.proof)).summary.receiptCount,4,'manifest-only inspection does not pretend to read missing originals');
});

test('full receipt semantics are verified even when the forged body has a freshly valid transport hash',async()=>{
  const f=await fixture(),parts=clone(f.rows),subject=parts.find(row=>row.head.version===3);
  // Keep byte length identical so the transport-only layer cannot detect this semantic alteration.
  const binding=subject.receipt.review.projection.sourceBindings.find(row=>row.archiveId);binding.archiveId='x'.repeat(binding.archiveId.length);
  assert.equal(file(subject.receipt).size,subject.head.bytes,'forgery reaches semantic checks, not just the byte-length guard');
  const sourceEntries=f.captured.entries.map(row=>row.id==='mapping:subjects:'+subject.head.digest?{...row,file:file(subject.receipt)}:row),built=await pack(sourceEntries),opened=await openStoryboardBundle(built.file);
  await assert.rejects(createBundleCarrierProof(opened));
});

test('receipt census catches missing sections and a mutated public manifest cannot change the frozen original text',async()=>{
  const f=await fixture(),built=await pack(f.captured.entries.slice(0,-1));await assert.rejects(createBundleCarrierProof(await openStoryboardBundle(built.file)),/分段缺失/);
  f.opened.manifest.chatKey='untrusted edited public view';f.opened.manifest.entries=[];assert.deepEqual(await createBundleCarrierProof(f.opened),f.proof);
});

test('proof and source readers remain bounded and refuse invalid UTF8, duplicate keys and oversized metadata',async()=>{
  const f=await fixture();await assert.rejects(inspectBundleCarrierProof({...f.proof,manifestText:' '.repeat(BUNDLE_CARRIER_LIMITS.manifest+1)}),/超限/);
  await assert.rejects(inspectStoryboardBundleManifestText(f.proof.manifestText.replace('"chatKey":','"chatKey":"duplicate","chatKey":')),/重复字段/);
  await assert.rejects(inspectStoryboardBundleManifestText(f.proof.manifestText.replace('carrier-chat','\uD800')),/完整UTF-8/);
  class NoWhole extends Blob{arrayBuffer(){assert.fail('whole bundle read');}}
  assert.deepEqual(await createBundleCarrierProof(await openStoryboardBundle(new NoWhole([f.built.file]))),f.proof);
});

test('cancellation after fetching a receipt stops before its body is expanded and no fallback is attempted',async()=>{
  const f=await fixture();let alive=true,loads=0;
  class NeverRead extends Blob{arrayBuffer(){assert.fail('cancelled body read');}}
  await assert.rejects(verifyBundleCarrierMembers(f.proof,{guard:async()=>{if(!alive)throw Error('closed');},load:async target=>{loads++;const original=await f.load(target);alive=false;return new NeverRead([original]);}}),/closed/);
  assert.equal(loads,1);
});
