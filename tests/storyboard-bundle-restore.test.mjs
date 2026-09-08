import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture as sourceFixture, namespace, chatKey, file, data } from './fixtures/storyboard-bundle.mjs';
import { createStoryboardBundleRestoreSession } from '../qianmu-storyboard-bundle-restore.js';
import { createStoryboardBundleConfiguration } from '../qianmu-storyboard-bundle-configuration.js';
import { planComfyLibraryRestore, comfyLibraryBackupDigest as digest } from '../qianmu-comfy-library-backup.js';
import { planComfyPoolRestore } from '../qianmu-comfy-pool-backup.js';
import { planCharacterLibraryRestore } from '../qianmu-character-library-backup.js';
import { validateResourceRestoreCheckpoint } from '../qianmu-storyboard-package-journal.js';
import { createStoryboardDefaults } from '../qianmu-storyboard.js';
import { vibeDigest } from '../qianmu-vibe-file.js';
import { randomUUID, createHash } from 'node:crypto';
import { hashText } from '../qianmu-storyboard-utils.js';
import { captureStoryboardChatEvidence } from '../qianmu-storyboard-chat-evidence.js';
import { captureStoryboardSubjectEvidence } from '../qianmu-storyboard-subject-evidence.js';

const clone = structuredClone;
async function fixture({ legacy = false, sourceIdentity = null, chatEvidence = false, subjectEvidence = false, sourceText = 'original text', missingAnchor = false } = {}) {
  const source = await sourceFixture(); source.config.chat.images[0].source = 'novel'; source.config.chat.images[0].floor = 0;
  source.config.chat.images[0].paragraphAnchor = { floor: 0 };
  if (!missingAnchor) source.config.chat.images[0].messageHash = hashText(sourceText);
  if (legacy) {
    source.config.settings.vibeLibrary = [{ id: 'legacy', name: 'Old Vibe', previewUrl: '/user/images/legacy.png', strength: 0, informationExtracted: 0 }];
    source.options.legacyFetch = async () => new Response(Buffer.from(data, 'base64'));
  }
  source.options.source = sourceIdentity;
  const subjectRows = [{ category: 'char', subjectKey: 'char:alice.png', state: 'present', profile: { name: 'Alice', description: 'original character' } }];
  if (subjectEvidence) { source.options.subjectEvidence = await captureStoryboardSubjectEvidence(subjectRows); source.sources.characters.bindings[0].archiveId = 'alice'; }
  if (chatEvidence) source.options.chatEvidence = await captureStoryboardChatEvidence([{ mes: sourceText, is_user: false, swipe_id: 0 }], chatKey);
  source.options.storyboard = file(source.config); const built = await source.build();
  const e = { active: true, events: [], files: new Map(), records: new Map(), mutation: null, settings: createStoryboardDefaults(), chat: {},
    messages: [{ mes: sourceText, is_user: false, swipe_id: 0 }], subjectRows, locals: clone(source.sources), vibes: false, configChanges: 0, mappings: new Map(), subjectMaps:new Map() };
  e.locals.workflows.workflows = []; e.locals.pools.pools = [];
  e.locals.characters.archives = []; e.locals.characters.bindings = []; e.locals.characters.usage = { count: 0, bytes: 0, bindings: 0 };
  const options = { namespace, chatKey, file: built.file, guard: async () => { if (!e.active) throw Error('inactive'); }, isCurrent: () => e.active,
    ...(sourceIdentity ? { sourceIdentity: { inspect: async () => clone(sourceIdentity) } } : {}),
    locks: { request: async (name, settings, fn) => { e.events.push(`lock:${name}`); return fn(e.lockUnavailable ? null : {}); } } };
  const store = key => ({ backup: async () => clone(e.locals[key]), usage: async () => ({ limit: e.limits?.[key] || (key === 'pools' ? 16 : 64) * 1024 * 1024 }),
    restoreBackup: async (ns, input, approved) => {
      assert.equal(ns, namespace); assert.equal(approved.confirmed, true); assert.equal(await digest(e.locals[key]), approved.expectedDigest);
      if (e.failAt === key) throw Error('synthetic failure');
      if (key === 'characters') e.locals[key] = planCharacterLibraryRestore(e.locals[key], input, approved).value;
      else {
        const plan = (key === 'pools' ? planComfyPoolRestore : planComfyLibraryRestore)(e.locals[key], input), rows = new Map(e.locals[key][key].map(row => [row.head.id, row]));
        for (const row of plan.writes) rows.set(row.head.id, { head: row.head, versions: [...(rows.get(row.head.id)?.versions || []), ...row.versions] });
        e.locals[key][key] = [...rows.values()].sort((a, b) => a.head.id.localeCompare(b.head.id));
      }
      e.events.push(key); if (e.afterStore) await e.afterStore(key); return {};
    } });
  options.workflowStore = store('workflows'); options.poolStore = store('pools'); options.characterStore = store('characters');
  options.images = { inspect: async receipt => ({ receipt: clone(receipt), state: receipt.url === e.conflict ? 'conflict' : e.files.has(receipt.url) ? 'present' : 'missing' }),
    restore: async (receipt, encoded, approved) => {
      assert.equal(approved.confirmed, true); assert.equal(encoded, data); assert.equal(e.records.get('bundle').phase, 'originals'); assert.equal(e.files.has(receipt.url), false);
      e.files.set(receipt.url, data); e.events.push('image'); if (e.afterImage) await e.afterImage(); return { state: 'created', receipt: clone(receipt) };
    } };
  options.vibeStage = { inspect: async () => ({ fileHash: await vibeDigest(new Uint8Array(await source.options.storyboard.arrayBuffer())), localHash: await digest(e.vibes), fits: !e.vibeFull, missing: e.vibes ? 0 : 1, rows: [], namespace }),
    stage: async (_file, proof, confirmed) => { assert.equal(confirmed, true); assert.equal(proof.localHash, await digest(e.vibes)); if (e.failAt === 'vibes') throw Error('synthetic vibe failure'); e.vibes = true; e.events.push('vibes'); } };
  options.journal = {
    loadSubjectMap:async(_ns,id)=>clone(e.subjectMaps.get(id)||null),
    inspectSubjectMap:async review=>({receipt:clone(e.subjectMaps.get(review.digest)||null),fits:!e.subjectMapFull}),
    prepareSubjectMap:async(review,approved)=>{assert.equal(approved.confirmed,true);if(e.failAt==='subjectMap')throw Error('synthetic subject map failure');const row=e.subjectMaps.get(review.digest)||{namespace,review:clone(review),createdAt:1};e.subjectMaps.set(review.digest,row);e.events.push('subjectMap');return clone(row);},
    inspectEnvironmentMap: async review => ({receipt:clone(e.mappings.get(review.digest)||null),fits:!e.mappingFull}),
    prepareEnvironmentMap: async (review,approved) => {assert.equal(approved.confirmed,true);if(e.failAt==='mapping')throw Error('synthetic mapping failure');const row=e.mappings.get(review.digest)||{key:review.digest,namespace,review:clone(review),createdAt:1};e.mappings.set(review.digest,row);e.events.push('mapping');return clone(row);},
    loadResource: async (_ns, kind = 'characters') => clone(e.records.get(kind) || null),
    prepareResource: async (descriptor, approved) => { assert.equal(approved.confirmed, true); assert.deepEqual(approved.previous, e.records.get(descriptor.kind) || null);
      if (e.failAt === 'journal') throw Error('synthetic journal failure');
      const row = validateResourceRestoreCheckpoint({ ...clone(descriptor), key: JSON.stringify([namespace, descriptor.kind]), version: 1, phase: 'prepared', revision: (approved.previous?.revision || 0) + 1, createdAt: 1, updatedAt: 1 });
      e.records.set(row.kind, row); e.events.push('prepared'); return clone(row); },
    updateResource: async (previous, phase) => { assert.deepEqual(previous, e.records.get(previous.kind)); const row = validateResourceRestoreCheckpoint({ ...previous, phase, revision: previous.revision + 1 }); e.records.set(row.kind, row); e.events.push(`phase:${phase}`); return clone(row); },
    loadMutation: async () => clone(e.mutation),
    prepareMutation: async row => { assert.equal(e.mutation, null); if (e.failAt === 'mutation') throw Error('synthetic mutation failure'); e.mutation = clone(row); e.events.push('mutation'); return clone(row); },
    updateMutation: async (previous, phase) => { assert.deepEqual(e.mutation, previous); e.mutation = { ...clone(previous), phase, revision: previous.revision + 1 }; return clone(e.mutation); },
  };
  options.configuration = createStoryboardBundleConfiguration({ namespace, chatKey, settings: e.settings, chat: e.chat, messages: () => e.messages,
    captureSubjects: async targets => captureStoryboardSubjectEvidence(e.subjectRows.filter(row=>targets.some(target=>target.category===row.category&&target.subjectKey===row.subjectKey))),
    journal: options.journal, guard: options.guard, isCurrent: options.isCurrent, persist: async () => { if (e.failAt === 'persist') throw Error('synthetic persist failure'); e.events.push('configuration'); } });
  const reopen = () => createStoryboardBundleRestoreSession(options);
  return { source, built, e, options, reopen, session: await reopen() };
}
const consent = { confirmed: true, environmentReviewed: true, bindingsReviewed: true, connectionsReviewed: true, resourcesReviewed: true };
const writes = e => e.events.filter(row => !row.startsWith('lock:'));
const subjectMappings=[{category:'char',sourceKey:'char:alice.png',targetKey:'char:renamed-alice.png'}];
async function remappedSubjectsFixture(){
  const f=await fixture({subjectEvidence:true,chatEvidence:true});f.e.subjectRows=[{category:'char',subjectKey:'char:alice.png',state:'missing'},
    {category:'char',subjectKey:subjectMappings[0].targetKey,state:'present',profile:{name:'Alice',description:'original character'}}];return f;
}
const subjectConsent={...consent,subjectsReviewed:true,subjectsMapped:true};
test('subject mapping restores a real target binding with new revision and retains original archive and historical recipes',async()=>{
  const f=await remappedSubjectsFixture(),before=clone(f.source.sources),original=(await f.session.preview());assert.equal(original.ready,false);assert.equal(f.e.files.size,0);
  const p=await f.session.preview({},subjectMappings);assert.equal(p.ready,true);assert.equal(p.subjectReview[0].state,'matched');assert.equal(p.bindingReview[0].subjectKey,subjectMappings[0].targetKey);
  await assert.rejects(f.session.restore(p,{...subjectConsent,subjectsMapped:false}),/单独确认/);assert.equal(writes(f.e).length,0);
  await f.session.restore(p,subjectConsent);assert.equal(f.e.subjectMaps.size,1);assert.ok(f.e.events.indexOf('subjectMap')<f.e.events.indexOf('image'));
  assert.match(f.e.locals.characters.bindings[0].revision,/^mapped-/);assert.equal(f.e.locals.characters.bindings[0].subjectKey,subjectMappings[0].targetKey);
  assert.deepEqual(f.e.locals.characters.archives,before.characters.archives);assert.deepEqual(f.source.sources,before);assert.deepEqual(f.e.locals.workflows,before.workflows);assert.equal(f.e.mutation.phase,'applied');
  const receipt=[...f.e.subjectMaps.values()][0].review;assert.equal(receipt.lineage[0].source.subjectKey,'char:alice.png');assert.equal(receipt.lineage[0].target.subjectKey,subjectMappings[0].targetKey);
});
test('partial subject restore reopens with an unapproved mapping draft and rejects switching targets before completion',async()=>{
  const f=await remappedSubjectsFixture(),p=await f.session.preview({},subjectMappings);f.e.failAt='vibes';await assert.rejects(f.session.restore(p,subjectConsent),/未全部确认/);assert.equal(f.e.subjectMaps.size,1);f.session.close();
  const resumed=await f.reopen(),next=await resumed.preview();assert.deepEqual(next.subjectMappings,subjectMappings);
  await assert.rejects(resumed.restore(next,{...subjectConsent,subjectsMapped:false}),/单独确认/);
  f.e.subjectRows.push({category:'char',subjectKey:'char:third.png',state:'present',profile:{name:'Third',description:'different'}});
  const changed=await resumed.preview({},[{...subjectMappings[0],targetKey:'char:third.png'}]);assert.equal(changed.ready,false);assert.equal(changed.subjectMappingConflict,true);
  f.e.failAt='';await resumed.restore(await resumed.preview({},subjectMappings),subjectConsent);assert.equal(f.e.subjectMaps.size,1);assert.equal(f.e.mutation.phase,'applied');
});
test('failed subject receipt write can be explicitly reconstructed after reopen without deleting its pending checkpoint',async()=>{
  const f=await remappedSubjectsFixture(),p=await f.session.preview({},subjectMappings);f.e.failAt='subjectMap';await assert.rejects(f.session.restore(p,subjectConsent),/未全部确认/);assert.equal(f.e.files.size,0);assert.equal(f.e.subjectMaps.size,0);f.session.close();
  const resumed=await f.reopen(),next=await resumed.preview();assert.equal(next.ready,false);assert.equal(next.subjectMappingConflict,true);assert.deepEqual(next.subjectMappings,[]);
  f.e.failAt='';await resumed.restore(await resumed.preview({},subjectMappings),subjectConsent);assert.equal(f.e.subjectMaps.size,1);assert.equal(f.e.mutation.phase,'applied');
});
test('subject target changes or missing durable lineage after original upload stop before applying archives/configuration',async()=>{
  const f=await remappedSubjectsFixture(),p=await f.session.preview({},subjectMappings);f.e.afterImage=async()=>{f.e.subjectRows[1].profile.description='changed';};
  await assert.rejects(f.session.restore(p,subjectConsent),/角色或人设来源已变化/);assert.ok(f.e.files.size);assert.equal(f.e.locals.characters.bindings.length,0);assert.equal(f.e.mutation,null);
  const g=await remappedSubjectsFixture(),gp=await g.session.preview({},subjectMappings);g.e.afterImage=async()=>g.e.subjectMaps.clear();
  await assert.rejects(g.session.restore(gp,subjectConsent),/角色映射凭据未确认/);assert.equal(g.e.mutation,null);
});
test('target binding conflicts retain local identity unless incoming is independently selected, without dropping original source mapping lineage',async()=>{
  const f=await remappedSubjectsFixture();f.e.locals.characters=clone(f.source.sources.characters);f.e.locals.characters.bindings[0]={...f.e.locals.characters.bindings[0],subjectKey:subjectMappings[0].targetKey,archiveId:'',revision:'local-revision'};
  const p=await f.session.preview({},subjectMappings),key=p.conflicts.find(row=>row.kind==='binding').key;assert.equal(p.ready,false);
  const keep=await f.session.preview({[key]:'local'},subjectMappings);assert.equal(keep.ready,true);assert.equal(keep.bindingReview.length,0);
  await f.session.restore(keep,subjectConsent);assert.equal(f.e.locals.characters.bindings[0].archiveId,'');assert.equal(f.e.locals.characters.bindings[0].revision,'local-revision');assert.equal(f.e.subjectMaps.size,1);
});
async function mappedFixture() {
  const identity={ok:true,version:1,state:'ready',expectedAccount:'st-user:'+createHash('sha256').update(namespace.slice(8)).digest('hex'),instanceId:randomUUID(),accountId:randomUUID(),proof:'installation-labels',automaticRebinding:false};
  const f=await fixture({sourceIdentity:identity,chatEvidence:true,subjectEvidence:true});f.session.close();
  f.e.target={...identity,instanceId:randomUUID(),accountId:randomUUID()};f.options.sourceIdentity.inspect=async()=>clone(f.e.target);
  f.session=await f.reopen();return f;
}
const mappedConsent={...consent,subjectsReviewed:true,environmentMapped:true};
test('different installation labels need independent consent and durable receipt before any original, with unchanged historical libraries',async()=>{
  const f=await mappedFixture(),preview=await f.session.preview(),sourceBefore=await digest(f.source.sources),fileBefore=f.built.fingerprint;
  assert.equal(preview.sourceLabelsMatched,false);assert.equal(preview.environmentReview.state,'mapping-required');assert.equal(preview.identityVerified,false);
  assert.equal(f.e.mappings.size,0);await assert.rejects(f.session.restore(preview,{...mappedConsent,environmentMapped:false}),/单独确认/);
  assert.equal(f.e.records.size,0);assert.equal(writes(f.e).length,0);
  await f.session.restore(preview,mappedConsent);assert.equal(f.e.mappings.size,1);assert.equal(f.e.mutation.phase,'applied');
  assert.ok(f.e.events.indexOf('mapping')<f.e.events.indexOf('image'));
  assert.equal(f.e.records.get('bundle').environmentDigest,preview.environmentReview.digest);
  assert.equal(await digest(f.e.locals.workflows),await digest(f.source.sources.workflows));assert.equal(await digest(f.e.locals.pools),await digest(f.source.sources.pools));
  assert.equal(await digest(f.e.locals.characters),await digest(f.source.sources.characters));assert.equal(await digest(f.source.sources),sourceBefore);assert.equal(f.built.fingerprint,fileBefore);
});
test('mapping capacity and failed receipt persistence stop before originals; saved receipt is read back before any phase',async()=>{
  const f=await mappedFixture();f.e.mappingFull=true;await assert.rejects(f.session.preview(),/空间不足/);assert.equal(writes(f.e).length,0);
  f.e.mappingFull=false;const p=await f.session.preview();f.e.failAt='mapping';await assert.rejects(f.session.restore(p,mappedConsent),/未全部确认/);
  assert.equal(f.e.files.size,0);assert.equal(f.e.mappings.size,0);assert.equal(f.e.records.get('bundle').phase,'prepared');
  f.e.failAt='';f.options.journal.prepareEnvironmentMap=async()=>({});const next=await f.session.preview();
  await assert.rejects(f.session.restore(next,mappedConsent),/凭据写入尚未确认/);assert.equal(f.e.files.size,0);
});
test('partial mapped restores require fresh consent on reopen, retain one receipt and cannot switch the destination',async()=>{
  const f=await mappedFixture();f.e.failAt='workflows';const p=await f.session.preview();await assert.rejects(f.session.restore(p,mappedConsent),/未全部确认/);
  assert.ok(f.e.files.size);assert.equal(f.e.mappings.size,1);f.session.close();const oldTarget=clone(f.e.target);f.e.target.accountId=randomUUID();
  const wrong=await f.reopen();await assert.rejects(wrong.preview(),/目标环境已变化/);wrong.close();f.e.target=oldTarget;f.e.failAt='';
  const resumed=await f.reopen(),next=await resumed.preview(),before=writes(f.e).length;
  await assert.rejects(resumed.restore(next,{...mappedConsent,environmentMapped:false}),/单独确认/);assert.equal(writes(f.e).length,before);
  await resumed.restore(next,mappedConsent);assert.equal(f.e.mappings.size,1);assert.equal(f.e.mutation.phase,'applied');
});
test('mapping target drift, missing required subjects and changed receipt all stop before configuration',async()=>{
  const f=await mappedFixture();f.e.subjectRows[0]={category:'char',subjectKey:'char:alice.png',state:'missing'};const missing=await f.session.preview();assert.equal(missing.ready,false);
  await assert.rejects(f.session.restore(missing,mappedConsent),/角色/);assert.equal(writes(f.e).length,0);
  const g=await mappedFixture(),p=await g.session.preview();g.e.afterImage=async()=>{g.e.target.instanceId=randomUUID();};
  await assert.rejects(g.session.restore(p,mappedConsent),/来源标识不同/);assert.ok(g.e.files.size);assert.equal(g.e.mutation,null);
  const h=await mappedFixture(),hp=await h.session.preview();h.e.afterImage=async()=>h.e.mappings.clear();
  await assert.rejects(h.session.restore(hp,mappedConsent),/凭据写入尚未确认/);assert.equal(h.e.mutation,null);
});

test('file-use pages are read-only and the external-dependency acknowledgement is enforced before any restore journal', async () => {
  const f=await fixture(),prepared=await f.session.preview(),before=structuredClone(f.e.locals),beforeWrites=writes(f.e);
  const page=await f.session.resources({filter:'all',offset:0});assert.equal(page.digest,prepared.summary.resourceOrigins.digest);assert.ok(page.rows.length<=24);
  assert.ok(page.rows.some(row=>row.kind==='workflow-review'));assert.deepEqual(f.e.locals,before);assert.deepEqual(writes(f.e),beforeWrites);
  await assert.rejects(f.session.restore(prepared,{...consent,resourcesReviewed:false}),/外部依赖/);assert.equal(f.e.records.size,0);assert.equal(f.e.files.size,0);
  await f.session.restore(prepared,consent);assert.equal(f.e.mutation.phase,'applied');
  f.session.close();await assert.rejects(f.session.resources({offset:0}),/页面已变化/);
});

test('bundle connection review has separate consent and never starts a resource write when omitted', async () => {
  const f = await fixture(), prepared = await f.session.preview();
  assert.equal(prepared.configuration.connections.length, 1);
  assert.equal(prepared.configuration.connections[0].state, 'added');
  assert.equal(prepared.configuration.connections[0].credential, 'required');
  await assert.rejects(f.session.restore(prepared, { ...consent, connectionsReviewed: false }), /连接差异/);
  assert.deepEqual(writes(f.e), []); assert.equal(f.e.mutation, null); assert.equal(f.e.records.size, 0);
  await f.session.restore(prepared, consent); assert.equal(f.e.settings.connections.comfy.presets[0].credentialId, '');
});

test('a transport edit after connection review invalidates the plan without overwriting credentials or writing files', async () => {
  const f = await fixture(); f.e.settings.connections.comfy.presets = [{id:'connection',name:'Local',providerId:'comfy',baseUrl:'',credentialId:'local-grant',headers:{},options:{}}];
  const prepared = await f.session.preview(); assert.equal(prepared.configuration.connections[0].credential, 'retained');
  f.e.settings.connections.comfy.presets[0].options.comfyTransport = 'browser';
  await assert.rejects(f.session.restore(prepared, consent), /确认后资源、配置/);
  assert.deepEqual(writes(f.e), []); assert.equal(f.e.settings.connections.comfy.presets[0].credentialId, 'local-grant');
});

test('same-name changed roles are displayed and require separate subject confirmation before restoring bindings', async () => {
  const f = await fixture({ subjectEvidence: true }); f.e.subjectRows[0].profile.description = 'new character with the same name';
  const prepared = await f.session.preview(); assert.equal(prepared.subjectReview[0].state, 'changed'); assert.equal(prepared.ready, true);
  await assert.rejects(f.session.restore(prepared, consent), /角色卡及人设/); assert.equal(writes(f.e).length, 0);
  await f.session.restore(prepared, { ...consent, subjectsReviewed: true }); assert.equal(f.e.locals.characters.bindings[0].archiveId, 'alice');
  assert.equal(f.source.sources.characters.bindings[0].revision, 'bind1');
});
test('missing required ST subject cannot inherit a same-name archive or start a partial restore', async () => {
  const f = await fixture({ subjectEvidence: true }); f.e.subjectRows[0] = { ...f.e.subjectRows[0], state: 'missing', profile: null };
  const prepared = await f.session.preview(); assert.equal(prepared.subjectReview[0].state, 'missing'); assert.equal(prepared.ready, false);
  await assert.rejects(f.session.restore(prepared, { ...consent, subjectsReviewed: true }), /冲突/); assert.equal(writes(f.e).length, 0);
});
test('changed subject after original upload preserves images and stops before applying role bindings', async () => {
  const f = await fixture({ subjectEvidence: true }), prepared = await f.session.preview();
  assert.equal(prepared.subjectReview[0].state, 'matched');
  f.e.afterImage = async () => { f.e.subjectRows[0].profile.description = 'changed during upload'; };
  await assert.rejects(f.session.restore(prepared, { ...consent, subjectsReviewed: true }), /角色或人设来源已变化/);
  assert.ok(f.e.files.size); assert.equal(f.e.locals.characters.bindings.length, 0); assert.equal(f.e.mutation, null);
});
test('a post-preview subject edit invalidates consent before journal or original writes', async () => {
  const f = await fixture({ subjectEvidence: true }), prepared = await f.session.preview(); f.e.subjectRows[0].profile.description = 'changed after preview';
  await assert.rejects(f.session.restore(prepared, { ...consent, subjectsReviewed: true }), /已变化/); assert.equal(writes(f.e).length, 0);
});

test('an old floor-only image stays in the gallery instead of silently binding to an unverified paragraph', async () => {
  const f = await fixture({ missingAnchor: true }), prepared = await f.session.preview(); assert.equal(prepared.configuration.orphaned, 1);
  await f.session.restore(prepared, consent); const saved = f.e.chat.storyboardImages[0];
  assert.equal(saved.floor, null); assert.equal(saved.lastKnownFloor, 0); assert.equal(saved.linkState, 'orphaned'); assert.ok(saved.url); assert.equal(saved.id, f.source.config.chat.images[0].id);
  assert.equal(saved.restoreLinkReview.sourceFloor, 0); assert.equal(saved.restoreLinkReview.sourceFingerprint, f.built.fingerprint); assert.equal(saved.inline, false);
});

test('chat evidence relocates a uniquely anchored image when earlier floors were inserted without rewriting the backup', async () => {
  const f = await fixture({ chatEvidence: true }); f.e.messages.unshift({ mes: 'earlier paragraph', is_user: true });
  const prepared = await f.session.preview(); assert.equal(prepared.configuration.orphaned, 0); assert.equal(prepared.configuration.chatChanged, true);
  await f.session.restore(prepared, consent); assert.equal(f.e.chat.storyboardImages[0].floor, 1); assert.equal(f.e.chat.storyboardImages[0].linkState, 'active');
  assert.equal(f.e.chat.storyboardImages[0].paragraphAnchor.floor, 1); assert.equal(f.e.chat.storyboardImages[0].lastKnownFloor, 1);
  assert.equal(f.source.config.chat.images[0].floor, 0);
});

test('changed text, speakers, swipe or ambiguous duplicate paragraphs stay detached with originals intact', async () => {
  for (const change of [messages => { messages[0].mes = 'BB'; }, messages => { messages[0].name = 'another'; }, messages => { messages[0].swipe_id = 1; }, messages => { messages.push(clone(messages[0])); }]) {
    const f = await fixture({ chatEvidence: true, sourceText: 'Aa' }); change(f.e.messages);
    const prepared = await f.session.preview(); assert.equal(prepared.configuration.orphaned, 1);
    await f.session.restore(prepared, consent); assert.equal(f.e.chat.storyboardImages[0].floor, null); assert.ok(f.e.files.size);
  }
});

test('weak-hash-colliding edits after configuration journalling cannot apply a stale attachment', async () => {
  const f = await fixture({ chatEvidence: true, sourceText: 'Aa' });
  const prepare = f.options.journal.prepareMutation; f.options.journal.prepareMutation = async value => { const result = await prepare(value); f.e.messages[0].mes = 'BB'; return result; };
  const prepared = await f.session.preview(); await assert.rejects(f.session.restore(prepared, consent), /正文或配置已变化/);
  assert.equal(f.e.events.includes('configuration'), false); assert.equal(f.e.chat.storyboardImages, undefined); assert.ok(f.e.mutation); assert.ok(f.e.files.size);
});

test('source-labelled restores pin live backend labels even for an identical handle/chat; they do not claim full identity verification', async () => {
  const identity = { ok: true, version: 1, state: 'ready', expectedAccount: 'st-user:' + createHash('sha256').update(namespace.slice(8)).digest('hex'),
    instanceId: randomUUID(), accountId: randomUUID(), proof: 'installation-labels', automaticRebinding: false };
  const f = await fixture({ sourceIdentity: identity });
  const prepared = await f.session.preview(); assert.equal(prepared.sourceLabelsMatched, true); assert.equal(prepared.identityVerified, false);
  const changed={...identity,instanceId:randomUUID()};f.options.sourceIdentity.inspect = async () => clone(changed);
  const other=await f.reopen();assert.equal((await other.preview()).environmentReview.state,'mapping-required');other.close();
  await assert.rejects(f.session.restore(prepared, consent), /来源标识不同/);
  assert.deepEqual(writes(f.e), []); assert.equal(f.e.files.size, 0);
  delete f.options.sourceIdentity; await assert.rejects(f.reopen(), /不能降级/); assert.deepEqual(writes(f.e), []);
  f.options.sourceIdentity = { inspect: async () => clone(identity) }; const restored = await f.reopen();
  const preview = await restored.preview(); await restored.restore(preview, consent); assert.ok(f.e.files.size); assert.ok(f.e.events.includes('configuration'));
});

test('source identity changes at a later restore phase preserve completed originals and stop before applying metadata or settings', async () => {
  const identity = { ok: true, version: 1, state: 'ready', expectedAccount: 'st-user:' + createHash('sha256').update(namespace.slice(8)).digest('hex'),
    instanceId: randomUUID(), accountId: randomUUID(), proof: 'installation-labels', automaticRebinding: false };
  const f = await fixture({ sourceIdentity: identity }); let changed = false;
  f.options.sourceIdentity.inspect = async () => changed ? { ...identity, accountId: randomUUID() } : clone(identity);
  f.e.afterStore = async key => { if (key === 'workflows') changed = true; };
  const prepared = await f.session.preview(); await assert.rejects(f.session.restore(prepared, consent), /来源标识不同/);
  assert.ok(f.e.files.size); assert.ok(f.e.events.includes('workflows')); assert.equal(f.e.events.includes('pools'), false); assert.equal(f.e.events.includes('configuration'), false);
});

test('legacy Vibe originals are restored before settings without changing URL recipes, zero parameters or asset type', async () => {
  const { session, e, source } = await fixture({ legacy: true }), preview = await session.preview();
  assert.equal(preview.summary.legacyVibeOriginals, 1); assert.equal(preview.images.length, 6); assert.equal(e.files.size, 0);
  await session.restore(preview, consent);
  assert.equal(e.files.get('/user/images/legacy.png'), data);
  const row = e.settings.vibeLibrary.find(row => row.id === 'legacy');
  assert.equal(row.previewUrl, source.config.settings.vibeLibrary[0].previewUrl);
  assert.equal(row.strength, 0); assert.equal(row.informationExtracted, 0); assert.equal(Object.hasOwn(row, 'assetRef'), false);
  assert.ok(e.events.lastIndexOf('image') < e.events.indexOf('configuration'));
});

test('different existing legacy Vibe bytes stop the whole restore before any resource or configuration writes', async () => {
  const { session, e } = await fixture({ legacy: true }); e.conflict = '/user/images/legacy.png';
  const preview = await session.preview(); assert.equal(preview.ready, false);
  await assert.rejects(session.restore(preview, consent), /冲突/);
  assert.equal(e.files.size, 0); assert.deepEqual(writes(e), []); assert.equal(e.mutation, null);
});

test('one restore preflights all libraries and configuration then applies resources before the journalled live merge', async () => {
  const { e, session, source } = await fixture(), before = clone(e.locals), view = await session.preview();
  assert.equal(view.ready, true); assert.equal(view.images.length, 5); assert.deepEqual(e.locals, before); assert.deepEqual(writes(e), []);
  const result = await session.restore(view, consent);
  assert.deepEqual(e.locals, source.sources); assert.equal(e.files.size, 5); assert.equal(result.resourcesVerified, true); assert.equal(result.settingsVerified, false);
  assert.deepEqual(e.events.filter(row => row.startsWith('phase:')), ['originals','workflows','pools','metadata','vibes','verified'].map(x => `phase:${x}`));
  assert.ok(e.events.indexOf('configuration') > e.events.indexOf('vibes')); assert.ok(e.events.indexOf('configuration') > e.events.indexOf('mutation'));
  assert.equal(e.mutation.phase, 'applied'); assert.match(e.chat.storyboardImages[0].url, /Qianmu-Storyboards\/import-/); assert.equal(e.chat.storyboardImages[0].floor, 0);
  await assert.rejects(session.preview(), /配置有待核对/);
});

test('every capacity or configuration rejection happens before original uploads and journal writes', async () => {
  for (const condition of ['workflowFull', 'poolFull', 'vibeFull', 'configInvalid']) {
    const { e, session, options } = await fixture();
    if (condition === 'workflowFull') e.limits = { workflows: 1 };
    if (condition === 'poolFull') e.limits = { pools: 1 };
    if (condition === 'vibeFull') e.vibeFull = true;
    // Configuration is frozen; use a fresh adapter which explicitly rejects the detached draft.
    if (condition === 'configInvalid') { options.configuration = { preview: async () => { throw Error('invalid configuration'); }, apply: async () => assert.fail('not reached') }; await assert.rejects((await createStoryboardBundleRestoreSession(options)).preview()); }
    else await assert.rejects(session.preview());
    assert.equal(e.files.size, 0); assert.deepEqual(writes(e), []);
  }
});

test('role keep-local choices omit only unused incoming role images, not shared config or pool originals', async () => {
  const { e, session, source } = await fixture(); e.locals.characters = clone(source.sources.characters);
  const role = e.locals.characters.archives[0]; role.document.name = 'local Alice'; role.document.imagegen.reference = null; role.document.imagegen.preview = null;
  role.head.name = role.document.name; role.head.cover = ''; role.head.bytes = file(role.document).size; e.locals.characters.usage.bytes = role.head.bytes;
  const unresolved = await session.preview(); assert.equal(unresolved.ready, false); assert.equal(unresolved.images.length, 0);
  const view = await session.preview({ 'archive:alice': 'local' }); assert.equal(view.images.length, 3);
  await session.restore(view, consent); assert.equal(e.locals.characters.archives[0].document.name, 'local Alice'); assert.equal(e.files.size, 3);
});

test('editing bundle conflict choices uses only the compact snapshot and invalidates every previous resource approval', async () => {
  const { e, session, source, options } = await fixture(); e.locals.characters = clone(source.sources.characters);
  const row = e.locals.characters.archives[0]; row.document.name = 'Local Alice'; row.head.name = row.document.name;
  row.head.bytes = file(row.document).size; e.locals.characters.usage.bytes = row.head.bytes;
  await session.preview(); let reads = 0;
  for (const [target, method] of [[options.workflowStore,'backup'],[options.poolStore,'backup'],[options.characterStore,'backup'],[options.images,'inspect'],[options.configuration,'preview']]) {
    // Configuration is frozen; its calls are not part of a choice snapshot either (covered by worker RPC tests).
    if (Object.isFrozen(target)) continue;
    const original = target[method]; target[method] = async (...args) => { reads++; return original(...args); };
  }
  const chosen = await session.choose({ 'archive:alice': 'local' });
  assert.equal(chosen.characterSummary.kept, 2); assert.equal(chosen.needsRecheck, true); assert.equal(chosen.ready, false);
  assert.equal(chosen.planDigest, ''); assert.deepEqual(chosen.images, []); assert.equal(chosen.vibe, null); assert.equal(chosen.poolSummary, null); assert.equal(reads, 0);
  assert.equal(chosen.summary.workflows.versions, 2);
  const rechecked = await session.preview(chosen.decisions); assert.equal(rechecked.ready, true); assert.ok(reads > 0);
  const changedBack = await session.choose({ 'archive:alice': 'incoming' }); assert.equal(changedBack.ready, false); assert.equal(changedBack.planDigest, '');
});

test('unconfirmed environment, changed configuration, changed image state and missing locks do not start a restore', async () => {
  const { e, session } = await fixture(), view = await session.preview();
  await assert.rejects(session.restore(view, { confirmed: true }), /原环境/); assert.deepEqual(writes(e), []);
  e.settings.profiles.comfy.model = 'local change'; await assert.rejects(session.restore(view, consent), /确认后/); assert.deepEqual(writes(e), []);
  const fresh = await session.preview(); e.files.set(fresh.images[0].url, data);
  await assert.rejects(session.restore(fresh, consent), /确认后/); assert.deepEqual(writes(e), []);
  e.lockUnavailable = true; await assert.rejects(session.restore(await session.preview(), consent), /另一页面/); assert.deepEqual(writes(e), []);
});

test('a different original at the destination is a blocking conflict, never an overwrite', async () => {
  const { e, session } = await fixture(); e.conflict = '/user/images/pool.png'; const view = await session.preview();
  assert.equal(view.ready, false); await assert.rejects(session.restore(view, consent), /冲突/); assert.equal(e.files.size, 0); assert.deepEqual(writes(e), []);
});

test('a lost original acknowledgement is explicitly resumed from receipts without duplicate uploads', async () => {
  const { e, session, reopen } = await fixture(); e.afterImage = () => { throw Error('lost acknowledgement'); };
  await assert.rejects(session.restore(await session.preview(), consent), { code: 'storyboard_bundle_restore_partial' }); assert.equal(e.files.size, 1); assert.equal(e.records.get('bundle').phase, 'originals');
  session.close(); e.afterImage = null; const next = await reopen(); await next.restore(await next.preview(), consent);
  assert.equal(e.files.size, 5); assert.equal(e.events.filter(x => x === 'image').length, 5);
});

test('failure at each later store keeps originals and explicitly resumes without changing fixed versions', async () => {
  for (const phase of ['workflows','pools','characters','vibes','mutation']) {
    const { e, session, reopen } = await fixture(); e.failAt = phase;
    await assert.rejects(session.restore(await session.preview(), consent)); assert.equal(e.files.size, 5); assert.equal(e.chat.storyboardImages, undefined);
    session.close(); e.failAt = ''; const next = await reopen(); await next.restore(await next.preview(), consent);
    assert.equal(e.events.filter(x => x === 'image').length, 5); assert.equal(e.locals.workflows.workflows[0].head.version, 2); assert.equal(e.locals.characters.archives[0].document.comfy.implementations[0].workflow.version, 1);
  }
});

test('an unconfirmed settings save leaves before/after recovery and forbids automatic bundle replay', async () => {
  const { e, session, reopen } = await fixture(); e.failAt = 'persist';
  await assert.rejects(session.restore(await session.preview(), consent)); assert.equal(e.records.get('bundle').phase, 'verified'); assert.equal(e.mutation.phase, 'uncertain');
  assert.equal(e.chat.storyboardImages.length, 1); assert.ok(e.mutation.patch.length); assert.equal(e.files.size, 5);
  await assert.rejects((await reopen()).preview(), /配置有待核对/);
});

test('a narrative edit during resources does not overwrite the live configuration or discard restored originals', async () => {
  const { e, session } = await fixture(); e.afterImage = () => { e.messages[0].mes = 'edited meanwhile'; };
  await assert.rejects(session.restore(await session.preview(), consent), /正文已变化/); assert.equal(e.chat.storyboardImages, undefined); assert.equal(e.mutation, null); assert.equal(e.files.size, 5);
});

test('a concurrently added local role is never overwritten by an earlier bundle approval', async () => {
  const { e, source, session, reopen } = await fixture(); let changed = false;
  e.afterImage = () => {
    if (changed) return; changed = true; const row = clone(source.sources.characters.archives[0]);
    row.head.id = 'local-only'; e.locals.characters.archives = [row]; e.locals.characters.usage = { count: 1, bytes: row.head.bytes, bindings: 0 };
  };
  await assert.rejects(session.restore(await session.preview(), consent), { code: 'storyboard_bundle_restore_partial' });
  assert.equal(e.locals.characters.archives[0].head.id, 'local-only'); assert.equal(e.chat.storyboardImages, undefined); assert.equal(e.records.get('bundle').phase, 'metadata');
  e.afterImage = null; const next = await reopen(); await next.restore(await next.preview(), consent);
  assert.deepEqual(e.locals.characters.archives.map(row => row.head.id), ['alice', 'local-only']); assert.equal(e.events.filter(x => x === 'image').length, 5);
});

test('a bad readback of a restored fixed workflow stops before pool, role or configuration writes', async () => {
  const { e, session } = await fixture(); e.afterStore = key => { if (key === 'workflows') e.locals.workflows.workflows = []; };
  await assert.rejects(session.restore(await session.preview(), consent), /固定工作流/);
  assert.equal(e.locals.pools.pools.length, 0); assert.equal(e.locals.characters.archives.length, 0); assert.equal(e.mutation, null); assert.equal(e.records.get('bundle').phase, 'workflows');
});

test('a closed session stops between image writes without starting any later stage', async () => {
  const { e, session } = await fixture(); e.afterImage = () => session.close();
  await assert.rejects(session.restore(await session.preview(), consent), { code: 'storyboard_bundle_restore_partial' });
  assert.equal(e.files.size, 1); assert.equal(e.locals.workflows.workflows.length, 0); assert.equal(e.mutation, null);
});

test('another source, another chat, stale character recovery and changed account are not inferred to be the same environment', async () => {
  const { e, options, session } = await fixture();
  await assert.rejects(createStoryboardBundleRestoreSession({ ...options, chatKey: 'other-chat' }), /原 ST/);
  await assert.rejects(createStoryboardBundleRestoreSession({ ...options, namespace: 'st-user:someone-else' }), /原 ST/);
  e.records.set('characters', { phase: 'metadata' }); await assert.rejects(session.preview(), /独立角色恢复/); e.records.clear();
  e.records.set('bundle', { phase: 'pools', sourceDigest: 'f'.repeat(64), chatHash: await vibeDigest(chatKey) }); await assert.rejects(session.preview(), /另一份/); e.records.clear();
  e.active = false; await assert.rejects(session.preview(), /页面已变化/); assert.deepEqual(writes(e), []);
});

test('bundle and legacy role checkpoints keep separate legal phases and require the bundle chat identity', () => {
  const base = { namespace, version: 1, sourceDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64), phase: 'pools', revision: 1, createdAt: 1, updatedAt: 1 };
  const bundle = { ...base, key: JSON.stringify([namespace, 'bundle']), kind: 'bundle', chatHash: 'c'.repeat(64) };
  assert.equal(validateResourceRestoreCheckpoint(bundle).phase, 'pools');
  assert.throws(() => validateResourceRestoreCheckpoint({ ...bundle, chatHash: undefined }));
  const role = { ...base, key: JSON.stringify([namespace, 'characters']), kind: 'characters' };
  assert.throws(() => validateResourceRestoreCheckpoint(role)); assert.equal(validateResourceRestoreCheckpoint({ ...role, phase: 'metadata' }).kind, 'characters');
});
