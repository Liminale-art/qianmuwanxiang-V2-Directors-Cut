import test from 'node:test';
import assert from 'node:assert/strict';
import { captureStoryboardChatEvidence, inspectStoryboardChatEvidence, projectStoryboardChatMessages, storyboardChatProjectionMatches,
  createStoryboardEvidenceLinkResolver } from '../qianmu-storyboard-chat-evidence.js';
import { hashText } from '../qianmu-storyboard-utils.js';
import { createStoryboardMessageReference } from '../qianmu-storyboard.js';
import { fixture, chatKey } from './fixtures/storyboard-bundle.mjs';
import { openStoryboardBundle } from '../qianmu-storyboard-bundle.js';
import { inspectStoryboardResourceBundle } from '../qianmu-storyboard-bundle-resources.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

const message = (mes = '正文🌸', extra = {}) => ({ mes, name: 'Alice', is_user: false, swipe_id: 0, original_avatar: 'alice.png', ...extra });
test('chat evidence freezes selected narrative fields, excludes bodies/extra data from output and validates its own complete digest', async () => {
  const input = [message(undefined, { extra: { apiKey: 'do-not-copy' }, swipes: ['hidden-text'], extension: 'private-plugin' })];
  const projected = projectStoryboardChatMessages(input); assert.doesNotMatch(JSON.stringify(projected), /do-not-copy|hidden-text|private-plugin/);
  const evidence = await captureStoryboardChatEvidence(input, chatKey);
  assert.equal(evidence.messages.length, 1); assert.deepEqual(await inspectStoryboardChatEvidence(evidence, chatKey), evidence);
  assert.doesNotMatch(JSON.stringify(evidence), /正文|Alice|alice.png|do-not-copy|hidden-text/);
  input[0].mes = 'new'; assert.equal(storyboardChatProjectionMatches(projected, input), false); assert.notEqual((await captureStoryboardChatEvidence(input, chatKey)).digest, evidence.digest);
});

test('metadata distinguishes speaker, role, swipe and time changes without copying the original fields', async () => {
  const original = await captureStoryboardChatEvidence([message()], chatKey);
  for (const update of [{ name: 'Bob' }, { is_user: true }, { is_system: true }, { swipe_id: 1 }, { original_avatar: 'new.png' }, { send_date: '2026-09-08' }]) {
    const next = await captureStoryboardChatEvidence([message(undefined, update)], chatKey); assert.notEqual(next.messages[0].sha256, original.messages[0].sha256);
  }
});

test('malformed scopes, sparse/foreign records, stale digests and unsupported fields are not repaired or truncated', async () => {
  const value = await captureStoryboardChatEvidence([message()], chatKey);
  for (const change of [{ chatKey: 'other' }, { schema: 'future' }, { apiKey: 'bad' }, { messages: [{ ...value.messages[0], floor: 1 }] },
    { messages: [{ ...value.messages[0], sha256: 'a'.repeat(64) }] }, { messages: [{ ...value.messages[0], text: 'body' }] }, { messages: [] }]) {
    await assert.rejects(inspectStoryboardChatEvidence({ ...value, ...change }, chatKey));
  }
  assert.throws(() => projectStoryboardChatMessages(new Array(100001)));
  assert.throws(() => projectStoryboardChatMessages(new Array(1)));
  assert.throws(() => projectStoryboardChatMessages([{ mes: {} }])); assert.throws(() => projectStoryboardChatMessages([message('', { swipe_id: -1 })]));
  assert.throws(() => projectStoryboardChatMessages([message('', { name: { apiKey: 'bad' } })]));
  await assert.rejects(captureStoryboardChatEvidence([message()], ''));
  await assert.rejects(captureStoryboardChatEvidence([message()], chatKey, { guard: async () => { throw Error('changed page'); } }), /changed page/);
});

test('unique matching content relocates an anchored image; duplicates, absent anchors and stale swipes do not guess a floor', async () => {
  const original = message(), source = await captureStoryboardChatEvidence([original], chatKey);
  const target = await captureStoryboardChatEvidence([message('before'), original], chatKey);
  const linked = createStoryboardEvidenceLinkResolver(source, target);
  const record = { floor: 0, swipeId: 0, messageHash: hashText(original.mes) }; assert.equal(linked(record), 1);
  assert.equal(linked({ floor: 0 }), null); assert.equal(linked({ ...record, swipeId: 1 }), null); assert.equal(linked({ ...record, floor: 2 }), null);
  assert.equal(linked({ ...record, restoreLinkReview: { version: 1 } }), null);
  assert.equal(linked({ floor: 0, messageRef: createStoryboardMessageReference({ message: original, floor: 0, chatKey, now: 1 }) }), 1);
  const ambiguous = createStoryboardEvidenceLinkResolver(source, await captureStoryboardChatEvidence([original, original], chatKey)); assert.equal(ambiguous(record), null);
});

test('production gallery reconciliation preserves a pending restore review instead of silently reattaching its old weak reference', () => {
  const record = { id: 'saved', floor: null, lastKnownFloor: 0, chatKey, messageHash: hashText('Aa'), messageRef: { messageKey: 'old-weak-id' }, linkState: 'orphaned', inline: false, restoreLinkReview: { version: 1 } };
  const deps = { ctx: () => ({ chat: [message('BB')] }), getChatKey: () => chatKey, storyboardGalleryRecords: () => [record], storyboardRecordChatKey: () => chatKey,
    storyboardScheduleLinkSave: () => assert.fail('must not save an inferred link'), resolveStoryboardMessageReference: () => assert.fail('must not resolve a pending restore review'),
    createStoryboardMessageReference, hashText };
  const api = new Function(...Object.keys(deps), ['storyboardRecoverLegacyMessageReference', 'storyboardReconcileGalleryLinks', 'storyboardRecordStatus'].map(storyboardFunctionSource).join('\n')
    + ';return {reconcile:storyboardReconcileGalleryLinks,status:storyboardRecordStatus,recover:storyboardRecoverLegacyMessageReference};')(...Object.values(deps));
  const before = structuredClone(record); assert.equal(api.reconcile(), false); assert.equal(api.status(record), '待核对正文位置'); assert.equal(api.recover(record, [message('BB')], chatKey), null); assert.deepEqual(record, before);
});

test('legacy weak-hash collisions cannot attach to a different body when source evidence is available', async () => {
  assert.equal(hashText('Aa'), hashText('BB'));
  const source = await captureStoryboardChatEvidence([message('Aa')], chatKey), target = await captureStoryboardChatEvidence([message('BB')], chatKey);
  assert.notEqual(source.messages[0].sha256, target.messages[0].sha256);
  assert.equal(createStoryboardEvidenceLinkResolver(source, target)({ floor: 0, messageHash: hashText('Aa'), swipeId: 0 }), null);
});

test('bundle retains the exact chat-evidence section but never synthesizes evidence for an older package', async () => {
  const f = await fixture(), old = await f.build(); assert.equal(old.manifest.entries.some(row => row.id === 'chat-evidence'), false);
  f.options.chatEvidence = await captureStoryboardChatEvidence([message()], chatKey); const built = await f.build(), opened = await openStoryboardBundle(built.file);
  assert.deepEqual(await opened.readJson('chat-evidence'), f.options.chatEvidence);
  const inspected = await inspectStoryboardResourceBundle(built.file); assert.equal(inspected.summary.chatEvidenceMessages, 1); assert.equal(inspected.summary.identityVerified, false);
  const before = structuredClone(f.reads); f.options.chatEvidence.chatKey = 'other'; await assert.rejects(f.build()); assert.deepEqual(f.reads, before);
});
