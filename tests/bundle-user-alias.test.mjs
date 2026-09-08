import test from 'node:test';
import assert from 'node:assert/strict';
import {aliasFixture,namespace,targetKey} from './fixtures/storyboard-user-aliases.mjs';
import {planBundleUserAliases,inspectBundleUserAliasReceipt,bundleUserAliasPage} from '../qianmu-bundle-user-alias.js';
import {captureStoryboardSubjectEvidence,storyboardSubjectTargets} from '../qianmu-storyboard-subject-evidence.js';
import {deriveStoryboardSubjectBindings,compareMappedStoryboardSubjects,createStoryboardSubjectMapReview,inspectStoryboardSubjectMapReview,normalizeStoryboardSubjectMappings,assertSubjectMappingTargetsUnambiguous} from '../qianmu-storyboard-subject-map.js';
import {planCharacterLibraryRestore,validateCharacterLibraryBackup} from '../qianmu-character-library-backup.js';
import {selectCharacterBinding} from '../qianmu-character-archive.js';
import {comfyLibraryBackupDigest as digest} from '../qianmu-comfy-library-backup.js';
const sourceDigest='a'.repeat(64),chatHash='e'.repeat(64),renamedKey='user:/User Avatars/renamed%20persona.png';
const clone=structuredClone;
async function evidenceFor(library,{mutate=()=>{},extra=[]}={}){
  const rows=storyboardSubjectTargets(library.bindings).map(row=>({...row,state:'present',profile:{name:'Player',description:'same original narrative'}}));
  mutate(rows);return captureStoryboardSubjectEvidence([...rows,...extra]);
}
async function fixture(options={}){const library=aliasFixture(options),evidence=await evidenceFor(library);return {library,evidence,sourceDigest};}
async function approved(input){const preview=await planBundleUserAliases(input),winner=preview.display.find(row=>row.conflict&&row.archiveId==='bob');
  const choices=winner?{[winner.groupId]:winner.candidateId}:{};return {plan:await planBundleUserAliases({...input,choices}),choices};}
async function rehash(value){const {digest:_,...core}=value;return {...core,digest:await digest(core)};}

test('unresolved source aliases expose no partially usable library and do not touch original documents or bindings',async()=>{
  const input=await fixture(),before=clone(input),p=await planBundleUserAliases(input);
  assert.equal(p.ready,false);assert.equal(p.value,null);assert.equal(p.after,null);assert.equal(p.receipt,null);assert.equal(p.unresolved,1);assert.equal(p.display.length,3);assert.deepEqual(input,before);
  assert.ok(p.display.every(row=>!Object.hasOwn(row,'present')),'source projection must not claim a live target exists');
});

test('source choice preserves all originals, null overrides and unrelated bindings, with separate source-bound revisions',async()=>{
  const input=await fixture(),before=clone(input),{plan:p}=await approved(input);
  validateCharacterLibraryBackup(p.value);assert.equal(p.value.usage.bindings,3);assert.deepEqual(p.value.archives,before.library.archives);assert.deepEqual(input,before);
  const subject={category:'user',subjectKey:targetKey};assert.equal(selectCharacterBinding(p.value.bindings,subject,'new-chat').archiveId,'bob');
  assert.equal(selectCharacterBinding(p.value.bindings,subject,'chat-one').archiveId,'');assert.equal(selectCharacterBinding(p.value.bindings,subject,'other-chat').revision,'unchanged');
  assert.ok(p.writes.every(row=>/^source-alias-[a-f0-9]{64}$/.test(row.revision)));assert.equal(p.receipt.sourceBindings.length,4);
  assert.ok(p.receipt.sourceBindings.some(row=>row.archiveId==='alice'&&row.scope==='default'));
  assert.deepEqual(p.receipt.sourceEvidence,input.evidence);assert.equal(p.evidence.subjects.length,1);assert.equal(p.evidence.subjects[0].sha256,input.evidence.subjects[0].sha256);
  assert.deepEqual(await inspectBundleUserAliasReceipt(p.receipt,{namespace,sourceDigest,bindings:input.library.bindings,evidence:input.evidence}),p.receipt);
});

test('source selection IDs and derivations cannot be reused for another package, account or evidence snapshot',async()=>{
  const input=await fixture(),{plan:p,choices}=await approved(input);
  for(const modified of [{...input,sourceDigest:'b'.repeat(64)},{...input,library:{...input.library,namespace:'st-user:other'}},
    {...input,evidence:await evidenceFor(input.library,{mutate:rows=>rows[0].profile.description='changed source'})}]){
    await assert.rejects(planBundleUserAliases({...modified,choices}),/过期/);
    const {plan:next}=await approved(modified);assert.notEqual(next.receipt.digest,p.receipt.digest);assert.notEqual(next.writes[0].revision,p.writes[0].revision);
  }
});

test('equivalent addresses with differing source descriptions stay explicitly unverified, never silently choose a profile',async()=>{
  const input=await fixture();input.evidence=await evidenceFor(input.library,{mutate:rows=>rows[0].profile.description='different original snapshot'});
  const {plan:p}=await approved(input);assert.equal(p.unverified,1);assert.equal(p.evidence.subjects[0].state,'unavailable');assert.equal(p.evidence.subjects[0].sha256,null);
  assert.deepEqual(p.receipt.sourceEvidence,input.evidence);assert.equal(new Set(p.receipt.sourceEvidence.subjects.map(row=>row.sha256)).size,2);
  const mappings=[{category:'user',sourceKey:targetKey,targetKey:renamedKey}],mapped=await deriveStoryboardSubjectBindings(p.value,p.evidence,mappings,sourceDigest);
  const target=await captureStoryboardSubjectEvidence([{category:'user',subjectKey:renamedKey,state:'present',profile:{name:'Player',description:'same original narrative'}}]);
  const compared=await compareMappedStoryboardSubjects(p.evidence,target,mapped.value.bindings,mappings);assert.equal(compared.ready,true);assert.equal(compared.rows[0].state,'unverified');
});

test('mixed missing/unavailable source evidence remains unresolved evidence while identical missing rows stay missing',async()=>{
  for(const states of [['present','missing','present'],['missing','missing','missing'],['unavailable','unavailable','unavailable']]){
    const input=await fixture();input.evidence=await evidenceFor(input.library,{mutate:rows=>rows.forEach((row,index)=>row.state=states[index])});
    const {plan:p}=await approved(input),same=states.every(state=>state===states[0]);
    assert.equal(p.evidence.subjects[0].state,same?states[0]:'unavailable');assert.equal(p.unverified,same?0:1);assert.deepEqual(p.receipt.sourceEvidence,input.evidence);
  }
});

test('normalizing source aliases composes with explicit filename remapping without weakening live target or many-to-one checks',async()=>{
  const input=await fixture(),{plan:p}=await approved(input),mappings=[{category:'user',sourceKey:targetKey,targetKey:renamedKey}];
  const mapped=await deriveStoryboardSubjectBindings(p.value,p.evidence,mappings,sourceDigest);
  const target=await captureStoryboardSubjectEvidence([{category:'user',subjectKey:renamedKey,state:'present',profile:{name:'Player',description:'same original narrative'}}]);
  const comparison=await compareMappedStoryboardSubjects(p.evidence,target,mapped.value.bindings,mappings);assert.equal(comparison.ready,true);assert.equal(comparison.rows[0].state,'matched');
  const review=await createStoryboardSubjectMapReview({namespace,chatHash,sourceDigest,sourceEvidence:p.evidence,targetEvidence:target,lineage:mapped.lineage,mappings});await inspectStoryboardSubjectMapReview(review);
  assert.equal(review.lineage.length,3);assert.equal(p.receipt.sourceBindings.length,4);assert.deepEqual(mapped.value.archives,input.library.archives);
  const final=new Map(mapped.lineage.map(pair=>[pair.source.revision,pair.target]));assert.ok(p.lineage.every(pair=>final.has(pair.target.revision)));assert.equal(final.get(p.lineage[0].target.revision).subjectKey,renamedKey);
  for(const state of ['missing','unavailable']){
    const missing=await captureStoryboardSubjectEvidence([{category:'user',subjectKey:renamedKey,state}]);
    assert.equal((await compareMappedStoryboardSubjects(p.evidence,missing,mapped.value.bindings,mappings)).ready,false);
  }
  assert.throws(()=>assertSubjectMappingTargetsUnambiguous({bindings:[{category:'user',subjectKey:'user:/User%20Avatars/renamed persona.png'}]},mappings),/不能绕过/);
  const two=[...p.evidence.subjects,{category:'user',subjectKey:renamedKey}];assert.throws(()=>normalizeStoryboardSubjectMappings(mappings,two),/不能合并/);
});

test('local target conflicts still require local/incoming choice after source resolution',async()=>{
  const input=await fixture(),{plan:p}=await approved(input),local=clone(p.value);
  local.bindings.find(row=>row.scope==='default').archiveId='alice';local.bindings.find(row=>row.scope==='default').revision='local';
  const conflict=planCharacterLibraryRestore(local,p.value);assert.equal(conflict.ready,false);assert.equal(conflict.conflicts.length,1);
  for(const choice of ['local','incoming']){
    const result=planCharacterLibraryRestore(local,p.value,{decisions:{[conflict.conflicts[0].key]:choice}});assert.equal(result.ready,true);
    assert.equal(result.value.bindings.find(row=>row.scope==='default').archiveId,choice==='local'?'alice':'bob');
  }
});

test('receipt tampering with source loss, selection, resulting digest or scope cannot pass by only recalculating its outer hash',async()=>{
  const input=await fixture(),{plan:p}=await approved(input);
  for(const mutate of [r=>r.sourceBindings.pop(),r=>r.selections.pop(),r=>r.selections[0].candidateId='f'.repeat(64),r=>r.selections.push(r.selections[0]),
    r=>r.projectedEvidenceDigest='f'.repeat(64),r=>r.projectedBindingsDigest='f'.repeat(64),r=>r.sourceBindings[0].archiveId='bob',r=>r.namespace='st-user:other',r=>r.sourceDigest='b'.repeat(64),
    r=>r.scope='local-user-alias-resolution',r=>r.apiKey='private',r=>r.sourceBindings[0].secret='private']){
    const changed=clone(p.receipt);mutate(changed);await assert.rejects(inspectBundleUserAliasReceipt(await rehash(changed)));
  }
  await assert.rejects(inspectBundleUserAliasReceipt(p.receipt,{namespace:'st-user:other'}));await assert.rejects(inspectBundleUserAliasReceipt(p.receipt,{sourceDigest:'c'.repeat(64)}));
  const fewer=clone(input.library.bindings);fewer.pop();await assert.rejects(inspectBundleUserAliasReceipt(p.receipt,{bindings:fewer}),/原包绑定/);
  const changedEvidence=await evidenceFor(input.library,{mutate:rows=>rows[0].profile.description='changed'});await assert.rejects(inspectBundleUserAliasReceipt(p.receipt,{evidence:changedEvidence}),/原包资料/);
});

test('missing binding evidence, malformed encoded paths and unknown source fields are rejected without repairing the original',async()=>{
  const input=await fixture(),before=clone(input);
  const evidence=await captureStoryboardSubjectEvidence([]);await assert.rejects(planBundleUserAliases({...input,evidence}),/缺少绑定来源/);
  for(const subjectKey of ['user:/User Avatars/%2fetc','user:/User Avatars/%GG','user:/User Avatars/..','user:/User Avatars/\uD800']){
    const library=clone(input.library);library.bindings=[{...library.bindings[0],subjectKey}];library.usage.bindings=1;
    await assert.rejects(planBundleUserAliases({...input,library,evidence:await evidenceFor(library)}));
  }
  const unknown=clone(input.library);unknown.bindings[0].secret='private';await assert.rejects(planBundleUserAliases({...input,library:unknown}));assert.deepEqual(input,before);
});

test('case differences, literal percent filenames and unrecognized legacy identities are not silently folded together',async()=>{
  const input=await fixture(),row=input.library.bindings[0];
  input.library.bindings=[targetKey,'user:/User Avatars/a%20B.png','user:/User Avatars/A%2520B.png','user:legacy-name'].map((subjectKey,index)=>({...row,subjectKey,revision:'original-'+index}));
  input.evidence=await evidenceFor(input.library);const p=await planBundleUserAliases(input);
  assert.equal(p.changed,false);assert.equal(p.groups,0);assert.equal(p.receipt,null);assert.deepEqual(p.value,input.library);assert.equal(p.evidence.subjects.length,4);
});

test('canonical evidence remains identical and evidence-only address aliases retain all originals without inventing bindings',async()=>{
  const input=await fixture();input.library.bindings=[];input.library.usage.bindings=0;
  const p=await planBundleUserAliases(input);assert.equal(p.ready,true);assert.equal(p.groups,0);assert.equal(p.changed,true);assert.equal(p.receipt.sourceBindings.length,0);
  assert.equal(p.evidence.subjects.length,1);assert.equal(p.receipt.sourceEvidence.subjects.length,3);await inspectBundleUserAliasReceipt(p.receipt);
  const normalized=await planBundleUserAliases({...input,evidence:p.evidence});assert.equal(normalized.changed,false);assert.equal(normalized.receipt,null);assert.deepEqual(normalized.evidence,p.evidence);
});

test('2048 source bindings keep every original and expose only a 24-row page without private archive content',async()=>{
  const input=await fixture({extra:2044}),{plan:p}=await approved(input);assert.equal(p.before.length,2048);assert.equal(p.receipt.sourceBindings.length,2048);assert.equal(p.after.length,2047);
  await inspectBundleUserAliasReceipt(p.receipt,{namespace,sourceDigest,bindings:input.library.bindings,evidence:input.evidence});
  const page=bundleUserAliasPage(p,2040);assert.equal(page.rows.length,7);assert.equal(page.total,2047);assert.ok(JSON.stringify(page).length<24000);
  assert.ok(!JSON.stringify(page).includes('private appearance'));assert.ok(!JSON.stringify(page).includes('same original narrative'));assert.ok(!Object.hasOwn(page,'receipt'));
  assert.throws(()=>bundleUserAliasPage(p,-24));assert.throws(()=>bundleUserAliasPage(p,1));assert.throws(()=>bundleUserAliasPage(p,2064));
});
