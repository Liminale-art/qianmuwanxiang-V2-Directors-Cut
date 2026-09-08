import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as subjectModule from '../qianmu-storyboard-subject-evidence.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';
import { projectStoryboardSubjects, readStoryboardSubjectProfiles, captureStoryboardSubjectEvidence, inspectStoryboardSubjectEvidence, compareStoryboardSubjectEvidence } from '../qianmu-storyboard-subject-evidence.js';
import { runStoryboardBundle } from '../qianmu-storyboard-bundle-runtime.js';
import { fixture } from './fixtures/storyboard-bundle.mjs';
import { inspectStoryboardResourceBundle } from '../qianmu-storyboard-bundle-resources.js';

const char = { category: 'char', subjectKey: 'char:alice.png' }, user = { category: 'user', subjectKey: 'user:/User Avatars/user%20avatar.png' };
const row = (target = char, profile = { name: 'Alice', description: 'private narrative text' }) => ({ ...target, state: 'present', profile });
const targets = [char, user], env = () => ({ characters: [{ avatar:'alice.png',name:'Alice',data:{description:'character content',personality:'calm',alternate_greetings:['one','two'],extensions:{apiKey:'never-forward'}} }],
  power:{personas:{'user avatar.png':'Me'},persona_descriptions:{'user avatar.png':{description:'persona content',position:0,depth:0,role:0,lorebook:'book',title:''}},apiKey:'never-forward'} });
test('ST reader uses exact avatar identity and retained persona maps, including empty and zero values', async () => {
  const e=env(), read=readStoryboardSubjectProfiles(targets,e);
  assert.equal(read[0].profile.description,'character content');assert.equal(read[1].profile.description,'persona content');
  assert.equal(read[1].profile.depth,0);assert.equal(read[1].profile.title,'');assert.equal(JSON.stringify(read).includes('never-forward'),false);
  e.characters[0].data.description='';assert.equal(readStoryboardSubjectProfiles([char],e)[0].profile.description,'');
  assert.equal(readStoryboardSubjectProfiles([{...char,subjectKey:'char:other.png'}],e)[0].state,'missing');
  assert.equal(readStoryboardSubjectProfiles([{...user,subjectKey:'user:/User Avatars/missing.png'}],e)[0].state,'missing');
});
test('lazy, missing fields, missing host APIs and custom OTHER identities are marked unavailable rather than invented', () => {
  const e=env();e.characters[0]._lazy=true;
  assert.equal(readStoryboardSubjectProfiles([char],e)[0].state,'unavailable');
  assert.equal(readStoryboardSubjectProfiles(targets,{}).every(row=>row.state==='unavailable'),true);
  delete e.power.persona_descriptions['user avatar.png'];assert.equal(readStoryboardSubjectProfiles([user],e)[0].state,'unavailable');
  assert.equal(readStoryboardSubjectProfiles([{category:'other',subjectKey:'manual:role'}],e)[0].state,'unavailable');
  e.characters.push({...e.characters[0]});assert.throws(()=>readStoryboardSubjectProfiles([char],e),/重复/);
});
test('captured evidence contains only declared subject identifiers and hashes, not prompts or credential fields', async () => {
  const input=row(char,{name:'Alice',description:'private narrative text',apiKey:'never-forward',extensions:{credentialId:'never-forward'}});
  const projected=projectStoryboardSubjects([input]);assert.equal(projected[0].profile.apiKey,undefined);
  const evidence=await captureStoryboardSubjectEvidence([input]);assert.equal(JSON.stringify(evidence).includes('private narrative text'),false);assert.equal(JSON.stringify(evidence).includes('never-forward'),false);
  assert.equal(evidence.subjects[0].sha256.length,64);assert.deepEqual(await inspectStoryboardSubjectEvidence(evidence),evidence);
  const changed=structuredClone(evidence);changed.subjects[0].sha256='b'.repeat(64);await assert.rejects(inspectStoryboardSubjectEvidence(changed),/摘要不符/);
  changed.extra='unsupported';await assert.rejects(inspectStoryboardSubjectEvidence(changed),/结构无效/);
});
test('semantic projections reject invalid known fields and duplicate identifiers without trimming or guessing', async () => {
  assert.throws(()=>projectStoryboardSubjects([row(),row()]),/重复/);
  assert.throws(()=>projectStoryboardSubjects([row(char,{description:{text:'not a string'}})]),/字段格式/);
  assert.throws(()=>projectStoryboardSubjects([row(char,{alternate_greetings:['a',1]})]),/开场白/);
  const missing=await captureStoryboardSubjectEvidence([{...char,state:'missing',profile:{description:'ignored'}}]);assert.equal(missing.subjects[0].sha256,null);
  const a=await captureStoryboardSubjectEvidence([row(char,{description:'Aa'})]),b=await captureStoryboardSubjectEvidence([row(char,{description:'BB'})]);assert.notEqual(a.digest,b.digest);
});
test('comparison distinguishes matched, changed, unreadable and absent subjects and blocks missing required targets', async () => {
  const source=await captureStoryboardSubjectEvidence([row()]),bindings=[{...char,archiveId:'alice'}];
  const same=await compareStoryboardSubjectEvidence(source,source,bindings);assert.equal(same.rows[0].state,'matched');assert.equal(same.ready,true);
  const changed=await captureStoryboardSubjectEvidence([row(char,{description:'changed'})]);assert.equal((await compareStoryboardSubjectEvidence(source,changed,bindings)).rows[0].state,'changed');
  const missing=await captureStoryboardSubjectEvidence([{...char,state:'missing'}]),noRead=await captureStoryboardSubjectEvidence([{...char,state:'unavailable'}]);
  assert.equal((await compareStoryboardSubjectEvidence(source,missing,bindings)).ready,false);
  assert.equal((await compareStoryboardSubjectEvidence(source,missing,[{...char,archiveId:''}])).ready,true);
  assert.equal((await compareStoryboardSubjectEvidence(source,noRead,bindings)).rows[0].state,'unverified');
  await assert.rejects(compareStoryboardSubjectEvidence(source,await captureStoryboardSubjectEvidence([]),bindings),/目标不完整/);
  await assert.rejects(compareStoryboardSubjectEvidence(source,source,[{...user,archiveId:'user'}]),/缺少/);
});
test('bundle source segment is verified, complete for original bindings, and never added to old bundles automatically', async () => {
  const f=await fixture();const original=await f.build();assert.equal(original.manifest.entries.some(row=>row.id==='subject-evidence'),false);
  f.options.subjectEvidence=await captureStoryboardSubjectEvidence([row()]);const built=await f.build();
  assert.equal(built.manifest.entries.some(row=>row.id==='subject-evidence'),true);assert.equal((await inspectStoryboardResourceBundle(built.file)).summary.subjectEvidenceCount,1);
  f.options.subjectEvidence=await captureStoryboardSubjectEvidence([]);await assert.rejects(f.build(),/缺少原绑定/);
});
test('worker boundary strips private extension fields, verifies returned subject directory and terminates', async () => {
  let sent,closed=0;
  class Worker {
    constructor(){this.listeners={};}addEventListener(kind,fn){this.listeners[kind]=fn;}terminate(){closed++;}
    postMessage(value){sent=value;void captureStoryboardSubjectEvidence(value.subjects).then(subjectEvidence=>this.listeners.message({data:{result:{subjectEvidence}}}));}
  }
  const input=row(char,{description:'text',credentialId:'not-forwarded'});
  const result=await runStoryboardBundle('subject-evidence',null,{subjects:[input],guard:async()=>{},WorkerClass:Worker});
  assert.equal(JSON.stringify(sent).includes('not-forwarded'),false);assert.equal(result.subjectEvidence.subjects.length,1);assert.equal(closed,1);
});

test('production stage cache compares actual fields and guards each read, without rehashing unchanged profiles', async () => {
  const e=env(),cache={};let hashes=0,guards=0,active=true;
  const context=vm.createContext({structuredClone,ctx:()=>({characters:e.characters,powerUserSettings:e.power}),featureRuntime:{load:async name=>name==='storyboardSubjectEvidence'?subjectModule:{runStoryboardBundle:async(_,__,{subjects})=>{hashes++;return {subjectEvidence:await captureStoryboardSubjectEvidence(subjects)};}}}});
  vm.runInContext(storyboardFunctionSource('storyboardCaptureSubjectEvidence'),context);
  const capture=()=>context.storyboardCaptureSubjectEvidence({namespace:'st-user:test',targets,cache,guard:async()=>{guards++;if(!active)throw Error('changed account');}});
  const first=await capture();const firstGuards=guards;first.subjects[0].sha256='x';
  assert.notEqual((await capture()).subjects[0].sha256,'x');assert.equal(hashes,1);assert.ok(guards>firstGuards);
  e.characters[0].data.extensions.apiKey='still-not-forwarded';await capture();assert.equal(hashes,1);
  e.characters[0].data.alternate_greetings[0]='changed';await capture();assert.equal(hashes,2);
  e.power.persona_descriptions['user avatar.png'].depth=1;await capture();assert.equal(hashes,3);
  active=false;await assert.rejects(capture(),/changed account/);assert.equal(hashes,3);
});
