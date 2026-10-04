import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import {galleryMembershipSnapshot} from '../qianmu-gallery-membership.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const copy = value => structuredClone(value);
function fixture() {
  const state = core.createStoryboardDefaults(); state.enabled = true;
  const snapshot = {
    chatKey: 'chat-a', source: 'novel', target: 'gallery', floor: null,
    profile: {model: 'nai-diffusion-4-5-full', width: 832, height: 1216, seed: 42, count: 1},
    connection: {id: 'original-connection', credentialId: 'original-key-ref', baseUrl: 'https://original.invalid'},
    payload: {prompt: '1woman, sitting, garden', negative: 'blurry', parameters: {steps: 28}},
    prompt: '1woman, sitting, garden', negative: 'blurry',
    imageAccountNamespace: 'account-a',
    imageAdmission: {version: 1, attemptId: 'old-attempt', namespace: 'account-a', scope: {namespace: 'account-a'}},
    floorTake: {id: 'old-take'},
  };
  const record = {
    id: 'image-a', floor: null, lastKnownFloor: null, chatKey: 'chat-a', source: 'novel',
    snapshotRef: 'snapshot-a', finalPrompt: snapshot.payload.prompt, negative: snapshot.payload.negative,
    imageAccountNamespace: 'account-a', imageAdmission: copy(snapshot.imageAdmission),
    variantRootId: 'variant-root', tags: ['garden'], collectionIds: ['collection-a'],
  };
  let original = snapshot, chatKey = 'chat-a', namespace = 'account-a', current = true, readHook, identityHook, queueHook;
  const records = [record], queued = [], messages = [], loads = [], guards = [], chat = [];
  let identityCalls = 0;
  const context = vm.createContext({
    ...core, Date, JSON, clone: copy, uid: () => 'new-shot-job', storyboardAdmissionEpoch: 1,
    storyboardState: () => state, ctx: () => ({chat}), getChatKey: () => chatKey,
    storyboardGalleryRecords: () => records, storyboardReconcileGalleryLinks: () => {},
    storyboardReadSnapshotForRecord: async () => {await readHook?.(); return original;},
    storyboardLoadRecordToWorkbench: () => assert.fail('must keep the info panel and its unsaved prompt'),
    storyboardGalleryGroupId: item => item.variantRootId, galleryMembershipSnapshot,
    uniqueClean: values => [...new Set(values.filter(Boolean))],
    storyboardRelinkRedrawSnapshot: () => assert.fail('unbound gallery image must not invent a prose anchor'),
    storyboardQueueJob: async (job, guard) => {guards.push(guard); await queueHook?.(); if (!guard()) return false; queued.push(job); return true;},
    toast: message => {messages.push(message); return false;},
    featureRuntime: {load: async name => {
      loads.push(name); assert.equal(name, 'imageAdmission', 'ordinary gallery redraw must not impersonate world approval');
      return {resolveImageAccountNamespace: async () => {identityCalls++; await identityHook?.(identityCalls); return namespace;}};
    }},
  });
  vm.runInContext(['storyboardJobFromLog', 'storyboardRedrawRecord'].map(section).join('\n'), context);
  return {
    state, snapshot, record, records, context, queued, messages, loads, guards, chat,
    setOriginal: value => {original = value;}, setChat: value => {chatKey = value;},
    setAccount: value => {namespace = value;}, cancel: () => {current = false;},
    onRead: callback => {readHook = callback;}, onIdentity: callback => {identityHook = callback;}, onQueue: callback => {queueHook = callback;},
    run: (options = {}) => context.storyboardRedrawRecord(record, {isCurrent: () => current, ...options}),
  };
}
function draftFor(e) {
  const draft = copy(e.snapshot);
  draft.prompt = draft.payload.prompt = '1woman, standing, garden, holding a red umbrella';
  draft.negative = draft.payload.negative = 'blurry, text';
  return draft;
}
async function noSubmission(e, options = {}) {
  try {await e.run(options);} catch (error) {assert.match(error.message, /未生成|未提交|已变化|正文位置|设置|配置|取消/);}
  assert.equal(e.queued.length, 0);
}

test('complete unbound gallery redraw queues one variant with the edited words and frozen provider configuration', async () => {
  const e = fixture(), override = draftFor(e);
  const before = copy({record: e.record, snapshot: e.snapshot, override});
  e.state.source = 'comfy'; e.state.profiles.novel.model = 'nai-diffusion-3';
  assert.equal(await e.run({snapshotOverride: override}), true);
  assert.equal(e.queued.length, 1);
  const job = e.queued[0];
  assert.equal(job.source, before.snapshot.source);
  assert.deepEqual(job.profile, before.snapshot.profile);
  assert.deepEqual(job.connection, before.snapshot.connection);
  assert.equal(job.payload.prompt, override.payload.prompt);
  assert.equal(job.payload.negative, override.payload.negative);
  assert.equal(job.target, 'gallery'); assert.equal(job.floor, null); assert.equal(job.inlineByDefault, false);
  assert.equal(job.messageRef, null); assert.equal(job.paragraphAnchor, null); assert.equal(job.paragraphSelection, null);
  assert.equal(job.planId, ''); assert.equal(job.planShotId, ''); assert.equal(job.floorTake, undefined);
  assert.equal(job.variantRootId, 'variant-root'); assert.equal(job.automatic, false); assert.equal(job.id, 'new-shot-job');
  assert.deepEqual(job.collectionIds, ['collection-a']); assert.deepEqual(Array.from(job.tags), ['garden']);
  assert.deepEqual(job.imageAdmission, before.snapshot.imageAdmission, 'keep old-attempt evidence for the admission review; never silently acknowledge it');
  assert.deepEqual({record: e.record, snapshot: e.snapshot, override}, before);
  assert.ok(e.loads.every(name => name === 'imageAdmission'));
});

test('unbound gallery can use the complete linked historical recipe without a snapshotOverride', async () => {
  const e = fixture(); e.setOriginal(null);
  e.state.logs.push({id: 'old-log', recordId: e.record.id, snapshot: copy(e.snapshot)});
  assert.equal(await e.run(), true); assert.equal(e.queued.length, 1);
  assert.equal(e.queued[0].payload.prompt, e.record.finalPrompt);
  assert.equal(e.queued[0].connection.credentialId, 'original-key-ref');
});

for (const [name, mutate] of [
  ['deleted numeric floor', e => {e.record.floor = e.snapshot.floor = 26; e.snapshot.target = 'floor';}],
  ['reconciled missing floor', e => {e.snapshot.target = 'floor'; e.record.lastKnownFloor = 26;}],
  ['stale original message reference', e => {e.snapshot.messageRef = {lastKnownFloor: 26};}],
  ['stale record message reference', e => {e.record.messageRef = {lastKnownFloor: 26};}],
  ['paragraph selection binding', e => {e.record.paragraphSelection = {indexes: [1]};}],
  ['original message hash', e => {e.snapshot.messageHash = 'old-text-hash';}],
  ['record last-known floor despite gallery target', e => {e.record.lastKnownFloor = 0;}],
]) test(`gallery-only path rejects ${name} without a workbench redirect or old-image mutation`, async () => {
  const e = fixture(); mutate(e); const override = draftFor(e), before = copy({record: e.record, snapshot: e.snapshot, override});
  await assert.rejects(e.run({snapshotOverride: override}), /原正文位置已不存在/);
  assert.equal(e.queued.length, 0); assert.deepEqual({record: e.record, snapshot: e.snapshot, override}, before);
});

for (const [name, mutate] of [
  ['foreign snapshot chat', e => {e.snapshot.chatKey = 'chat-b';}],
  ['foreign record chat', e => {e.record.chatKey = 'chat-b';}],
  ['foreign snapshot namespace', e => {e.snapshot.imageAccountNamespace = 'account-b';}],
  ['foreign record namespace', e => {e.record.imageAccountNamespace = 'account-b';}],
  ['foreign admission scope', e => {e.snapshot.imageAdmission.scope.namespace = 'account-b';}],
  ['record removed from gallery', e => {e.records.length = 0;}],
  ['empty active chat', e => {e.setChat('');}],
  ['empty account namespace', e => {e.setAccount('');}],
]) test(`gallery redraw refuses ${name} in the information panel`, async () => {
  const e = fixture(); mutate(e); const override = draftFor(e);
  await assert.rejects(e.run({snapshotOverride: override}), /账户、聊天或原图已变化/);
  assert.equal(e.queued.length, 0); assert.equal(override.payload.prompt, '1woman, standing, garden, holding a red umbrella');
});

for (const [name, mutate] of [
  ['no original recipe', e => e.setOriginal(null)],
  ['missing original source', e => {delete e.snapshot.source;}],
  ['missing original profile', e => {delete e.snapshot.profile;}],
  ['missing original payload', e => {delete e.snapshot.payload;}],
  ['missing connection URL', e => {e.snapshot.connection.baseUrl = '';}],
  ['missing credential reference', e => {e.snapshot.connection.credentialId = '';}],
  ['missing model', e => {e.snapshot.profile.model = '';}],
]) test(`gallery redraw rejects ${name}; complete editor data cannot upgrade an incomplete old recipe`, async () => {
  const e = fixture(); mutate(e); const override = copy(e.snapshot);
  if (override.payload) override.payload.prompt = 'edited scene';
  await assert.rejects(e.run({snapshotOverride: override}), /设置|配置|正文位置|连接快照/);
  assert.equal(e.queued.length, 0);
});

for (const [name, mutate] of [
  ['source', s => {s.source = 'comfy';}], ['model', s => {s.profile.model = 'nai-diffusion-3';}],
  ['connection', s => {s.connection.baseUrl = 'https://different.invalid';}],
  ['credential', s => {s.connection.credentialId = 'different-key-ref';}],
  ['target', s => {s.target = 'floor';}], ['floor', s => {s.floor = 0;}],
  ['chat', s => {s.chatKey = 'chat-b';}], ['namespace', s => {s.imageAccountNamespace = 'account-b';}],
  ['old-attempt evidence', s => {s.imageAdmission.attemptId = 'unrelated-attempt';}],
]) test(`editor override cannot replace original gallery ${name}`, async () => {
  const e = fixture(), override = draftFor(e); mutate(override);
  await assert.rejects(e.run({snapshotOverride: override}), /原图生成配置与编辑草稿不一致/);
  assert.equal(e.queued.length, 0);
});

test('Comfy character inclusion editing remains compatible without allowing workflow/model changes', async () => {
  const e = fixture(); e.snapshot.source = e.record.source = 'comfy';
  e.snapshot.profile = {model: 'comfy-workflow', comfyCharacterEnabled: true, count: 3, comfyWorkflow: '{"workflow":"frozen"}'};
  const override = draftFor(e); override.profile.comfyCharacterEnabled = false;
  assert.equal(await e.run({snapshotOverride: override}), true);
  assert.equal(e.queued.length, 1); assert.equal(e.queued[0].profile.count, 3);
  assert.equal(e.queued[0].profile.comfyCharacterEnabled, false);
  assert.equal(e.queued[0].profile.comfyWorkflow, e.snapshot.profile.comfyWorkflow);
});

test('cancel while original recipe is loading cannot submit and preserves original and editor draft', async () => {
  const e = fixture(), override = draftFor(e), before = copy({record: e.record, snapshot: e.snapshot, override});
  let release; const gate = new Promise(resolve => {release = resolve;}); e.onRead(() => gate);
  const pending = e.run({snapshotOverride: override}); await new Promise(resolve => setImmediate(resolve));
  e.cancel(); release(); await pending;
  assert.equal(e.queued.length, 0); assert.deepEqual({record: e.record, snapshot: e.snapshot, override}, before);
});

for (const [name, mutate] of [
  ['cancel', e => e.cancel()], ['account switch', e => e.setAccount('account-b')],
  ['chat switch', e => e.setChat('chat-b')], ['snapshot reference changed', e => {e.record.snapshotRef = 'other';}],
  ['original prompt changed', e => {e.record.finalPrompt = 'changed elsewhere';}],
  ['record removed', e => {e.records.length = 0;}], ['namespace provenance changed', e => {e.record.imageAccountNamespace = 'account-b';}],
  ['record ID changed', e => {e.record.id = 'another-image';}],
  ['original suddenly becomes a world picture', e => {e.record.productionContext = {packetId: 'another-source'};}],
]) test(`gallery redraw stops ${name} during the account check before queueing`, async () => {
  const e = fixture(), override = draftFor(e); e.onIdentity(call => {if (call === 2) mutate(e);});
  await noSubmission(e, {snapshotOverride: override});
});

test('cancel during final preparation verification submits zero jobs', async () => {
  const e = fixture(), override = draftFor(e); let checks = 0;
  await noSubmission(e, {snapshotOverride: override, verify: async () => {if (++checks === 2) e.cancel();}});
  assert.ok(checks >= 2);
});

test('queue-entry guard still rejects a removed original or cancelled information panel', async () => {
  for (const mutate of [e => e.cancel(), e => {e.records.length = 0;}]) {
    const e = fixture(), override = draftFor(e); e.onQueue(() => mutate(e));
    assert.equal(await e.run({snapshotOverride: override}), false); assert.equal(e.queued.length, 0);
    assert.equal(e.guards.length, 1); assert.equal(e.guards[0](), false);
  }
});

test('recipeUnavailable originals reject before loading, queueing, or consulting editor input', async () => {
  const e = fixture(); e.record.recipeUnavailable = true;
  assert.equal(await e.run({snapshotOverride: draftFor(e)}), false);
  assert.equal(e.queued.length, 0); assert.equal(e.loads.length, 0); assert.match(e.messages[0], /原生成配置/);
});
