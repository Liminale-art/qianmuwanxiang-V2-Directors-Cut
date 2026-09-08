import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,namespace,chatKey} from './fixtures/storyboard-bundle.mjs';
import {captureStoryboardSubjectEvidence,listStoryboardSubjectTargets,readStoryboardSubjectProfiles} from '../qianmu-storyboard-subject-evidence.js';
import {deriveStoryboardSubjectBindings,normalizeStoryboardSubjectMappings,compareMappedStoryboardSubjects,createStoryboardSubjectMapReview,inspectStoryboardSubjectMapReview,validStoryboardSubjectTargetPage,assertSubjectMappingTargetsUnambiguous} from '../qianmu-storyboard-subject-map.js';
import {comfyLibraryBackupDigest as digest} from '../qianmu-comfy-library-backup.js';
const mappings=[{category:'char',sourceKey:'char:alice.png',targetKey:'char:renamed.png'}],sourceDigest='a'.repeat(64);
async function sample(){const f=await fixture(),library=structuredClone(f.sources.characters);library.bindings[0].archiveId='alice';
  const source=await captureStoryboardSubjectEvidence([{category:'char',subjectKey:'char:alice.png',state:'present',profile:{name:'Alice',description:'original'}}]);
  const target=await captureStoryboardSubjectEvidence([{category:'char',subjectKey:'char:renamed.png',state:'present',profile:{name:'Alice',description:'original'}}]);return {library,source,target};}
test('explicit target mapping changes only current binding identity and derives a new revision without rewriting archives or source',async()=>{
  const {library,source,target}=await sample(),before=await digest(library),plan=await deriveStoryboardSubjectBindings(library,source,mappings,sourceDigest);
  assert.equal(await digest(library),before);assert.deepEqual(plan.value.archives,library.archives);assert.equal(plan.value.bindings[0].subjectKey,mappings[0].targetKey);assert.match(plan.value.bindings[0].revision,/^mapped-[a-f0-9]{64}$/);
  assert.notEqual(plan.value.bindings[0].revision,library.bindings[0].revision);assert.deepEqual(plan.lineage[0].source,library.bindings[0]);
  assert.deepEqual((await deriveStoryboardSubjectBindings(library,source,mappings,sourceDigest)).value,plan.value);
  const review=await compareMappedStoryboardSubjects(source,target,plan.value.bindings,mappings);assert.equal(review.ready,true);assert.equal(review.rows[0].state,'matched');assert.equal(review.rows[0].targetKey,mappings[0].targetKey);
});
test('many-to-one including unchanged targets and percent-encoded persona aliases are refused, without guessing OTHER bindings',()=>{
  const subjects=[{category:'char',subjectKey:'char:alice.png'},{category:'char',subjectKey:'char:bob.png'}];
  for(const choices of [[{...mappings[0],targetKey:'char:bob.png'}],[...mappings,{category:'char',sourceKey:'char:bob.png',targetKey:mappings[0].targetKey}],[...mappings,...mappings],[{...mappings[0],sourceKey:'char:absent.png'}],[{...mappings[0],category:'other'}]])assert.throws(()=>normalizeStoryboardSubjectMappings(choices,subjects));
  const users=[{category:'user',subjectKey:'user:/User Avatars/one.png'},{category:'user',subjectKey:'user:/User Avatars/two.png'}];
  assert.throws(()=>normalizeStoryboardSubjectMappings([{category:'user',sourceKey:users[0].subjectKey,targetKey:'user:/User%20Avatars/two%2Epng'}],users),/不能合并/);
  for(const targetKey of ['user:/User Avatars/%2fetc','user:/User Avatars/%GG','user:/User Avatars/..'])assert.throws(()=>normalizeStoryboardSubjectMappings([{category:'user',sourceKey:users[0].subjectKey,targetKey}],users));
});
test('persona destination aliases cannot silently bypass an existing local binding conflict',()=>{
  const input=[{category:'user',sourceKey:'user:/User Avatars/old.png',targetKey:'user:/User Avatars/new.png'}];
  assert.throws(()=>assertSubjectMappingTargetsUnambiguous({bindings:[{category:'user',subjectKey:'user:/User%20Avatars/new%2Epng'}]},input),/不能绕过/);
  assert.doesNotThrow(()=>assertSubjectMappingTargetsUnambiguous({bindings:[{category:'user',subjectKey:input[0].targetKey}]},input));
});
test('mapped targets must be present even for explicit null binding overrides, and changed source content stays visible',async()=>{
  const {library,source,target}=await sample(),plan=await deriveStoryboardSubjectBindings(library,source,mappings,sourceDigest);
  const changed=await captureStoryboardSubjectEvidence([{category:'char',subjectKey:mappings[0].targetKey,state:'present',profile:{name:'Alice',description:'changed'}}]);
  assert.equal((await compareMappedStoryboardSubjects(source,changed,plan.value.bindings,mappings)).rows[0].state,'changed');
  for(const state of ['missing','unavailable']){const absent=await captureStoryboardSubjectEvidence([{category:'char',subjectKey:mappings[0].targetKey,state}]);assert.equal((await compareMappedStoryboardSubjects(source,absent,[],mappings)).ready,false);}
  await assert.rejects(compareMappedStoryboardSubjects(source,target,library.bindings,mappings),/缺少/);
});
test('subject mapping receipt retains full original and proposed binding lineage and rejects recomputed forged revisions or extra data',async()=>{
  const {library,source,target}=await sample(),plan=await deriveStoryboardSubjectBindings(library,source,mappings,sourceDigest);
  const review=await createStoryboardSubjectMapReview({namespace,chatHash:'b'.repeat(64),sourceDigest,sourceEvidence:source,targetEvidence:target,lineage:plan.lineage,mappings});
  assert.deepEqual(await inspectStoryboardSubjectMapReview(review),review);assert.equal(review.scope,'declared-binding-mappings');
  for(const field of ['revision','archiveId','chatKey','subjectKey']){const forged=structuredClone(review);forged.lineage[0].target[field]='altered';const{digest:_,...core}=forged;forged.digest=await digest(core);await assert.rejects(inspectStoryboardSubjectMapReview(forged));}
  await assert.rejects(inspectStoryboardSubjectMapReview({...review,apiKey:'secret'}));assert.equal(review.lineage[0].source.archiveId,'alice');
});
test('CHAR/USER catalogue search is paged and exposes only names and exact identifiers, no profile or automatic selection',()=>{
  const characters=Array.from({length:49},(_,i)=>({avatar:`role-${String(i).padStart(2,'0')}.png`,name:i<2?'same name':`Role ${i}`,description:'private narrative',extensions:{secret:'private'}}));
  const page=listStoryboardSubjectTargets({category:'char',query:'',offset:24},{characters});assert.equal(page.rows.length,24);assert.equal(page.total,49);assert.equal(validStoryboardSubjectTargetPage(page),true);assert.equal(JSON.stringify(page).includes('private'),false);
  assert.equal(listStoryboardSubjectTargets({category:'char',query:'same name',offset:0},{characters}).total,2);
  assert.throws(()=>listStoryboardSubjectTargets({category:'char',query:'absent',offset:24},{characters}),/变化/);
  const user=listStoryboardSubjectTargets({category:'user',query:'',offset:0},{power:{personas:{'space name.png':'User'}}});assert.equal(user.rows[0].subjectKey,'user:/User Avatars/space%20name.png');
  assert.equal(validStoryboardSubjectTargetPage({...page,rows:[{...page.rows[0],secret:'bad'}]}),false);
});
test('USER mapping uses the actual persona catalogue and narrative reader while preserving chat/default/null override distinctions',async()=>{
  const {library}=await sample();library.archives[0].head.category='user';library.archives[0].document.category='user';
  library.bindings= [{...library.bindings[0],category:'user',subjectKey:'user:/User Avatars/old.png',scope:'default',chatKey:''},
    {...library.bindings[0],category:'user',subjectKey:'user:/User Avatars/old.png',scope:'chat',chatKey,archiveId:'',revision:'override'}];library.usage.bindings=2;
  const power={personas:{'new persona.png':'Player'},persona_descriptions:{'new persona.png':{description:'original',position:0,depth:0}}};
  const [candidate]=listStoryboardSubjectTargets({category:'user',query:'Player',offset:0},{power}).rows;
  const source=await captureStoryboardSubjectEvidence([{category:'user',subjectKey:'user:/User Avatars/old.png',state:'present',profile:{name:'Player',description:'original',position:0,depth:0}}]);
  const selected=[{category:'user',sourceKey:source.subjects[0].subjectKey,targetKey:candidate.subjectKey}],plan=await deriveStoryboardSubjectBindings(library,source,selected,sourceDigest);
  const target=await captureStoryboardSubjectEvidence(readStoryboardSubjectProfiles([{category:'user',subjectKey:candidate.subjectKey}],{power}));
  const compared=await compareMappedStoryboardSubjects(source,target,plan.value.bindings,selected);assert.equal(compared.ready,true);assert.equal(compared.rows[0].state,'matched');
  assert.equal(plan.value.bindings.find(row=>row.scope==='chat').archiveId,'');assert.equal(plan.value.bindings.find(row=>row.scope==='default').archiveId,'alice');
  const review=await createStoryboardSubjectMapReview({namespace,chatHash:'b'.repeat(64),sourceDigest,sourceEvidence:source,targetEvidence:target,lineage:plan.lineage,mappings:selected});
  assert.equal((await inspectStoryboardSubjectMapReview(review)).lineage.length,2);assert.ok(review.lineage.every(pair=>pair.source.subjectKey!==pair.target.subjectKey));
});
