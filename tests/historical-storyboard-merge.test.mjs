import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { historicalSourceFixture } from './helpers/historical-source-fixture.mjs';
import { planHistoricalStoryboardMerge as plan } from '../qianmu-historical-storyboard-merge.js';
import { captureStoryboardChatEvidence } from '../qianmu-storyboard-chat-evidence.js';
import { createChatCharacterDraft } from '../qianmu-character-chat-draft.js';
import { vibeDigest } from '../qianmu-vibe-file.js';
import { captureHistoricalStoryboardSource } from '../qianmu-historical-storyboard-source.js';

async function fixture(t, prepare) {
  const f = await historicalSourceFixture(t);
  if (prepare) { prepare(f); await f.write(); }
  const session = await f.capture(); f.source = session.source; session.close();
  f.sourceOptions = f.options;
  f.options = (currentSaved = {}) => ({ source: f.source, namespace: f.source.namespace, target: f.target, currentSaved,
    currentEvidence: f.source.chatEvidence, guard: async () => {} });
  return f;
}
const copy = structuredClone;
function localDraft(f, name = '当前人物') {
  const owner = f.source.saved.characterDrafts.owner;
  return copy(createChatCharacterDraft({ owner, source: { kind: 'body', chatKey: owner.chatKey, messageKey: '1', revisionId: 'local', characterId: 'LOCAL' }, character: { id: 'LOCAL', name, identity: ['brown hair'] } }));
}

test('lossless same-chat merge preserves originals, full baseline, absent slots and unknown draft fields without file writes', async t => {
  const f = await fixture(t), bytes = await readFile(f.file), calls = f.calls.length;
  const result = await plan(f.options());
  assert.equal(result.compatible, true); assert.equal(result.restoreSupported, false);
  assert.deepEqual(result.before, {}); assert.deepEqual(result.proposedSaved, f.source.saved);
  assert.deepEqual(result.changedFields, ['storyboardImages', 'storyboardCollections', 'characterDrafts']);
  assert.deepEqual(result.added, { storyboardImages: 2, storyboardCollections: 1, characterDrafts: 1 });
  assert.equal(result.proposedSaved.characterDrafts.items[0].future.note, ' preserve exact fields ');
  assert.equal(result.proposedSaved.storyboardCollections[0].future.zero, 0);
  assert.deepEqual(result.requiredStages, ['verified-originals', 'recipe-reference-resolution', 'dependency-review', 'durable-host-save']);
  const { digest, ...core } = result; assert.equal(digest, await vibeDigest(JSON.stringify(core)));
  assert.equal(f.calls.length, calls); assert.deepEqual(await readFile(f.file), bytes);
  result.proposedSaved.characterDrafts.items[0].future.note = 'caller edit';
  assert.equal(f.source.saved.characterDrafts.items[0].future.note, ' preserve exact fields ');
});

test('identical rows are reused irrespective of object-key order and are not duplicated', async t => {
  const f = await fixture(t), local = copy(f.source.saved);
  local.storyboardImages[0] = Object.fromEntries(Object.entries(local.storyboardImages[0]).reverse());
  const result = await plan(f.options(local));
  assert.deepEqual(result.changedFields, []); assert.deepEqual(result.proposedSaved, local);
  assert.deepEqual(result.added, { storyboardImages: 0, storyboardCollections: 0, characterDrafts: 0 });
});

test('local rows and ordering survive; only missing exact identities are appended', async t => {
  const f = await fixture(t), local = copy(f.source.saved), original = copy(local);
  local.storyboardImages = [{ id: 'local', createdAt: 7, future: 0 }, local.storyboardImages[1]];
  local.storyboardCollections.unshift({ id: 'another', name: '原册', future: { local: true } });
  const result = await plan(f.options(local));
  assert.deepEqual(result.proposedSaved.storyboardImages.map(row => row.id), ['local', 'server', 'inline']);
  assert.deepEqual(result.proposedSaved.storyboardCollections.map(row => row.id), ['another', 'album']);
  assert.deepEqual(result.proposedSaved.characterDrafts, original.characterDrafts);
  assert.deepEqual(result.before, local);
});

for (const [field, mutate] of [
  ['storyboardImages', s => s.storyboardImages[0].future = { changed: true }],
  ['storyboardCollections', s => s.storyboardCollections[0].name = '本机重命名'],
  ['characterDrafts', s => s.characterDrafts.items[0].future.note = 'user-edited'],
]) test(`changed same-ID ${field} prevents the entire proposal rather than last-write-wins`, async t => {
  const f = await fixture(t), local = copy(f.source.saved); mutate(local);
  const before = copy(local), result = await plan(f.options(local));
  assert.equal(result.compatible, false); assert.equal(result.proposedSaved, null); assert.equal(result.added, null);
  assert.deepEqual(result.changedFields, []); assert.ok(result.conflicts.some(row => row.field === field && row.reason === 'different-record'));
  assert.deepEqual(local, before);
});

test('a rejected local draft is not revived by an older detected original', async t => {
  const f = await fixture(t), local = copy(f.source.saved);
  local.characterDrafts.items[0].status = 'rejected'; local.characterDrafts.items[0].revision++;
  const result = await plan(f.options(local)); assert.equal(result.compatible, false); assert.equal(local.characterDrafts.items[0].status, 'rejected');
});

test('draft union preserves both raw records, custom collection fields and advances only the local collection counter', async t => {
  const f = await fixture(t, f => f.saved.characterDrafts.futureCollection = { exact: '  keep  ' });
  const local = { characterDrafts: { ...copy(f.source.saved.characterDrafts), revision: 9, items: [localDraft(f)], localExtension: false } };
  delete local.characterDrafts.futureCollection;
  const result = await plan(f.options(local));
  assert.equal(result.compatible, true); assert.equal(result.proposedSaved.characterDrafts.revision, 10);
  assert.deepEqual(result.proposedSaved.characterDrafts.items, [local.characterDrafts.items[0], f.source.saved.characterDrafts.items[0]]);
  assert.equal(result.proposedSaved.characterDrafts.localExtension, false);
  assert.deepEqual(result.proposedSaved.characterDrafts.futureCollection, { exact: '  keep  ' });
  assert.equal(local.characterDrafts.revision, 9);
});

test('different collection extension values conflict instead of dropping either version', async t => {
  const f = await fixture(t, f => f.saved.characterDrafts.futureCollection = 0), local = copy(f.source.saved);
  local.characterDrafts.futureCollection = false;
  const result = await plan(f.options(local)); assert.equal(result.proposedSaved, null);
  assert.ok(result.conflicts.some(row => row.key === 'futureCollection' && row.reason === 'different-collection-field'));
});

test('imported collection version alone cannot bump or roll back the current version', async t => {
  const f = await fixture(t), local = copy(f.source.saved); local.characterDrafts.revision = 23;
  const result = await plan(f.options(local)); assert.deepEqual(result.changedFields, []); assert.equal(result.proposedSaved.characterDrafts.revision, 23);
});

test('different draft IDs with the same origin are conflicts, not new independent people', async t => {
  const f = await fixture(t), local = copy(f.source.saved), incoming = local.characterDrafts.items[0];
  const replacement = localDraft(f); replacement.source = copy(incoming.source);
  local.characterDrafts.items = [replacement];
  const result = await plan(f.options(local)); assert.equal(result.compatible, false);
  assert.ok(result.conflicts.some(row => row.reason === 'incompatible-identities-or-size'));
});

test('different draft IDs cannot claim the same explicit host character', async t => {
  const f = await fixture(t, f => {
    const draft = f.saved.characterDrafts.items[0]; draft.hostSubject = { category: 'char', subjectKey: 'char:Alice.png' }; draft.document.category = 'char';
  });
  const local = copy(f.source.saved), replacement = localDraft(f);
  replacement.hostSubject = copy(local.characterDrafts.items[0].hostSubject); replacement.document.category = 'char';
  local.characterDrafts.items = [replacement];
  const result = await plan(f.options(local)); assert.equal(result.proposedSaved, null);
  assert.ok(result.conflicts.some(row => row.reason === 'incompatible-identities-or-size'));
});

test('nonconflicting future collection extension alone is preserved as a real revision', async t => {
  const f = await fixture(t, f => f.saved.characterDrafts.futureCollection = { blank: '', zero: 0 });
  const local = copy(f.source.saved); delete local.characterDrafts.futureCollection;
  const result = await plan(f.options(local));
  assert.equal(result.proposedSaved.characterDrafts.revision, 2); assert.equal(result.added.characterDrafts, 0);
  assert.deepEqual(result.proposedSaved.characterDrafts.futureCollection, { blank: '', zero: 0 });
  assert.deepEqual(result.changedFields, ['characterDrafts']);
});

test('same display name alone does not merge distinct explicit draft identities', async t => {
  const f = await fixture(t), local = { characterDrafts: { ...copy(f.source.saved.characterDrafts), items: [localDraft(f, '原聊天人物')] } };
  const result = await plan(f.options(local)); assert.equal(result.compatible, true); assert.equal(result.proposedSaved.characterDrafts.items.length, 2);
});

test('missing historical optional fields never clear local data and absent stays distinct from empty', async t => {
  const f = await fixture(t, f => { f.rows.splice(0); delete f.saved.characterDrafts; delete f.saved.storyboardCollections; });
  const local = { storyboardCollections: [{ id: 'keep', name: 'keep' }] }, result = await plan(f.options(local));
  assert.deepEqual(result.proposedSaved, { ...local, storyboardImages: [] });
  assert.deepEqual(result.changedFields, ['storyboardImages']);
  assert.equal(Object.hasOwn(result.proposedSaved, 'characterDrafts'), false);
});

test('same chat name under another character/group or account is not a restore target', async t => {
  const f = await fixture(t);
  for (const extra of [{ namespace: 'st-user:bob' }, { target: { ...f.target, avatar: 'Other.png' } }, { target: { kind: 'group', chatId: f.target.chatId } }, { target: { ...f.target, surprise: true } }]) {
    await assert.rejects(plan({ ...f.options(), ...extra }));
  }
});

test('changed body, changed swipe or forged evidence is blocked, without treating floor numbers as identity', async t => {
  const f = await fixture(t);
  for (const messages of [[{ mes: 'changed' }], f.messages.map((row, i) => ({ ...row, swipe_id: i ? 0 : 9 }))]) {
    const currentEvidence = await captureStoryboardChatEvidence(messages, f.target.chatId);
    await assert.rejects(plan({ ...f.options(), currentEvidence }), /正文|版本/);
  }
  const currentEvidence = copy(f.source.chatEvidence); currentEvidence.digest = '0'.repeat(64);
  await assert.rejects(plan({ ...f.options(), currentEvidence }), /摘要/);
});

test('partial originals cannot silently restore all unselected albums and drafts', async t => {
  const f = await fixture(t), session = await captureHistoricalStoryboardSource({ ...f.sourceOptions(), recordIds: ['server'] });
  await assert.rejects(plan({ ...f.options(), source: session.source }), /部分选择/); session.close();
});

test('source hashes and original recipes are revalidated before proposing metadata', async t => {
  const f = await fixture(t), source = copy(f.source); source.recipes[1].snapshot.prompt = 'tampered';
  await assert.rejects(plan({ ...f.options(), source }), /指纹/);
});

test('duplicate IDs, invalid present data and non-JSON future fields are never normalized away', async t => {
  const f = await fixture(t);
  for (const currentSaved of [ { storyboardImages: null }, { characterDrafts: null }, { storyboardImages: [f.source.saved.storyboardImages[0], f.source.saved.storyboardImages[0]] },
    { storyboardCollections: [{ id: '', name: 'empty id' }] }, { storyboardImages: [{ id: 'x', unknown: undefined }] }, { storyboardCollections: new Date() }, { imagegen: {} }]) await assert.rejects(plan(f.options(currentSaved)));
});

test('item, raw-extension size and revision limits stop the proposal without truncation', async t => {
  const f = await fixture(t);
  await assert.rejects(plan(f.options({ storyboardImages: Array.from({ length: 400 }, (_, i) => ({ id: 'local-' + i })) })), /超限/);
  await assert.rejects(plan(f.options({ storyboardCollections: Array.from({ length: 120 }, (_, i) => ({ id: 'local-' + i })) })), /超限/);
  const local = copy(f.source.saved); local.characterDrafts.items = []; local.characterDrafts.revision = Number.MAX_SAFE_INTEGER;
  await assert.rejects(plan(f.options(local)), /版本/);
  local.characterDrafts.revision = 1; local.characterDrafts.future = 'x'.repeat(1024 * 1024);
  await assert.rejects(plan(f.options(local)), /超|范围/);
});

test('input baseline, source and target are detached before asynchronous guard yields', async t => {
  const f = await fixture(t), options = { ...f.options(copy(f.source.saved)), source: copy(f.source), target: copy(f.target), currentEvidence: copy(f.source.chatEvidence) };
  const before = copy(options.currentSaved); let calls = 0;
  options.guard = async () => { if (++calls !== 1) return; options.target.chatId = 'redirected'; options.currentSaved.storyboardImages = []; options.source.namespace = 'st-user:other'; options.currentEvidence.digest = '0'.repeat(64); };
  const result = await plan(options); assert.deepEqual(result.before, before); assert.deepEqual(result.target, f.target); assert.deepEqual(result.changedFields, []);
});

test('account/epoch guard is mandatory and a late guard failure never returns a usable proposal', async t => {
  const f = await fixture(t); await assert.rejects(plan({ ...f.options(), guard: undefined }), /保护/);
  let checks = 0; await plan({ ...f.options(), guard: async () => checks++ });
  let called = 0; await assert.rejects(plan({ ...f.options(), guard: async () => { if (++called === checks) throw Error('account changed'); } }), /account changed/);
});
