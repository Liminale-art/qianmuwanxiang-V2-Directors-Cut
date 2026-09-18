import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { historicalRestoreFixture as fixture } from './helpers/historical-restore-fixture.mjs';
import { png } from './helpers/historical-original-restore-fixture.mjs';
import { createHistoricalChatMutation } from '../qianmu-historical-chat-journal.js';

test('unified restore preserves originals, full recipes and raw chat fields with actual final reads', async t => {
  const f = await fixture(t); await f.hideArchive(); const before = structuredClone(f.context.chatMetadata), session = f.open();
  const view = await session.preview(); assert.equal(view.ready, true); assert.equal(view.mode, 'fresh'); assert.equal(f.saves, 0); assert.equal(f.recipeCalls.length, 0);
  const result = await session.restore({ confirmed: true, dependenciesAccepted: true, expectedDigest: view.digest });
  assert.equal(result.status, 'restored'); assert.equal(result.originalsVerified, 2); assert.equal(result.recipesVerified, 2); assert.equal(result.durableJournal, true);
  assert.equal(result.restoreSupported, false); assert.equal(result.dependenciesRestored, false); assert.equal(f.saves, 1);
  assert.equal(f.journal.record.phase, 'verified'); assert.deepEqual(f.journal.calls, ['prepared', 'submitted', 'verified']);
  const after = f.context.chatMetadata; assert.notDeepEqual(after.story_director_liminale.storyboardImages[1].snapshotServerRef, f.rows[1].snapshotServerRef);
  const restored = structuredClone(after); restored.story_director_liminale.storyboardImages[1].snapshotServerRef = before.story_director_liminale.storyboardImages[1].snapshotServerRef;
  assert.deepEqual(restored, before); assert.deepEqual(f.context.chat, f.messages);
  for (const name of ['inline.png', 'server.png']) assert.deepEqual(await fs.readFile(path.join(f.images, name)), png);
  assert.ok(f.traffic.filter(call => call.url.endsWith('/recipe/read')).length >= 2);
  assert.ok(f.traffic.every(call => !new Headers(call.options.headers).has('authorization')));
});

test('native silent failure retains journal; reload and explicit retry converge, then repetition is read-only', async t => {
  const f = await fixture(t); await f.hideArchive(); f.host = async () => {};
  await assert.rejects(f.apply(f.open()), error => error.state === 'needs_review'); assert.equal(f.saves, 1); assert.ok(f.journal.record);
  await f.reload(); f.host = f.persist; const retry = f.open(), view = await retry.preview(); assert.equal(view.mode, 'recovery');
  const result = await retry.restore({ confirmed: true, dependenciesAccepted: true, expectedDigest: view.digest }); assert.equal(result.status, 'restored'); assert.equal(f.saves, 2);
  await f.reload(); const recipeWrites = f.recipeCalls.length, imageWrites = f.traffic.filter(row => row.url.endsWith('/image/restore/restore')).length;
  assert.equal((await f.apply(f.open())).status, 'restored'); assert.equal(f.saves, 2); assert.equal(f.recipeCalls.length, recipeWrites);
  assert.equal(f.traffic.filter(row => row.url.endsWith('/image/restore/restore')).length, imageWrites);
});

test('confirmation binds preview and dependency exclusions; no consent causes no writes', async t => {
  const f = await fixture(t), s = f.open(), view = await s.preview();
  for (const input of [{}, { confirmed: true, expectedDigest: view.digest }, { confirmed: true, dependenciesAccepted: true, expectedDigest: 'stale' }]) await assert.rejects(s.restore(input));
  assert.equal(f.saves, 0); assert.equal(f.recipeCalls.length, 0); assert.equal(f.traffic.some(row => row.url.endsWith('/image/restore/restore')), false);
});

test('same image path with other content is a conflict and never overwritten', async t => {
  const f = await fixture(t), wrong = Buffer.from('existing user file'); await fs.writeFile(path.join(f.images, 'inline.png'), wrong);
  const s = f.open(), view = await s.preview(); assert.equal(view.ready, false);
  await assert.rejects(s.restore({ confirmed: true, dependenciesAccepted: true, expectedDigest: view.digest })); assert.deepEqual(await fs.readFile(path.join(f.images, 'inline.png')), wrong); assert.equal(f.saves, 0);
});

test('local/server divergence, edited body and account switches reject before any restore write', async t => {
  for (const change of [f => { f.context.chatMetadata.story_director_liminale.storyboardCollections.push({ id: 'local', name: 'unsaved' }); },
    f => { f.context.chat[0].mes += ' changed'; }, f => { f.namespace = 'st-user:bob'; }, f => { f.epoch++; }]) {
    const f = await fixture(t), s = f.open(); await s.preview(); change(f);
    await assert.rejects(f.apply(s)); assert.equal(f.saves, 0); assert.equal(f.recipeCalls.length, 0);
    assert.equal(f.traffic.some(row => row.url.endsWith('/image/restore/restore')), false);
  }
});

test('metadata conflict and partial selection cannot enter unified restoration', async t => {
  const f = await fixture(t), row = f.context.chatMetadata.story_director_liminale.storyboardImages[0]; row.future = 'edited'; await f.persist();
  await assert.rejects(f.open().preview()); assert.equal(f.saves, 0);
  const partial = await fixture(t, { recordIds: ['inline'] }); await assert.rejects(partial.open().preview()); assert.equal(partial.saves, 0);
});

test('journal quota failure leaves recovered files but never submits native metadata', async t => {
  const f = await fixture(t); await f.hideArchive(); const before = structuredClone(f.context.chatMetadata);
  f.journal.prepareHistoricalChatMutation = async () => { throw Error('QuotaExceededError'); };
  await assert.rejects(f.apply(f.open()), error => error.state === 'needs_review'); assert.equal(f.saves, 0); assert.deepEqual(f.context.chatMetadata, before);
  assert.deepEqual(await fs.readFile(path.join(f.images, 'inline.png')), png); assert.equal(f.journal.record, null);
});

test('files deleted after recipe stage prevent native save', async t => {
  const f = await fixture(t); await f.hideArchive(); const fetch = f.fullFetch;
  const s = f.open({ fetchImpl: async (url, options) => { const result = await fetch(url, options); if (url.endsWith('/recipe/restore')) await fs.rename(path.join(f.images, 'inline.png'), path.join(f.images, 'inline.retained')); return result; } });
  await assert.rejects(f.apply(s), error => error.state === 'needs_review'); assert.equal(f.saves, 0); assert.equal(f.journal.record, null);
});

test('post-save missing original never reports complete and keeps verified intent for review', async t => {
  const f = await fixture(t); await f.hideArchive(); f.host = async () => { await f.persist(); await fs.rename(path.join(f.images, 'inline.png'), path.join(f.images, 'inline.retained')); };
  await assert.rejects(f.apply(f.open()), error => error.state === 'needs_review'); assert.equal(f.saves, 1); assert.equal(f.journal.record.phase, 'verified');
  await f.reload(); await assert.rejects(f.open().preview()); assert.equal(f.saves, 1);
});

test('post-save corrupt recipe never reports complete or replays a verified host mutation', async t => {
  const f = await fixture(t); await f.hideArchive(); f.host = async () => { await f.persist(); const ref = f.context.chatMetadata.story_director_liminale.storyboardImages[1].snapshotServerRef; await fs.writeFile(path.join(f.archive, ref.id + '.json'), 'corrupt'); };
  await assert.rejects(f.apply(f.open()), error => error.state === 'needs_review'); assert.equal(f.saves, 1);
  await f.reload(); const before = f.recipeCalls.length; await assert.rejects(f.apply(f.open()), error => error.state === 'needs_review'); assert.equal(f.saves, 1); assert.equal(f.recipeCalls.length, before);
});

test('empty or invalid durable journal dependency is rejected at construction', async t => {
  const f = await fixture(t); for (const journal of [null, {}, { loadHistoricalChatMutation() {} }]) assert.throws(() => f.open({ journal }));
  assert.throws(() => f.open({ namespace: 'st-user:' + 'x'.repeat(600) }));
});

test('closed and timed-out sessions cannot later complete an ignored-abort request', async t => {
  const f = await fixture(t), s = f.open({ timeoutMs: 15, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(s.preview()); assert.equal(f.saves, 0); s.close(); await assert.rejects(s.preview());
});

test('missing records, albums and raw character drafts are actually restored together', async t => {
  const f = await fixture(t); await f.hideArchive(); const store = f.context.chatMetadata.story_director_liminale;
  store.storyboardImages = []; store.storyboardCollections = []; store.characterDrafts.items = []; store.characterDrafts.revision = 0; await f.persist();
  assert.equal((await f.apply(f.open())).status, 'restored'); assert.equal(f.saves, 1); assert.equal(store.storyboardImages.length, 2);
  assert.deepEqual(store.storyboardCollections, f.source.saved.storyboardCollections); assert.deepEqual(store.characterDrafts, f.source.saved.characterDrafts);
});

test('unchanged metadata needs no native save or journal mutation but still verifies all files', async t => {
  const f = await fixture(t); const result = await f.apply(f.open());
  assert.equal(result.status, 'restored'); assert.equal(result.durableJournal, false); assert.equal(f.saves, 0); assert.equal(f.journal.record, null);
  const writes = f.traffic.filter(row => row.url.endsWith('/image/restore/restore')).length;
  assert.equal((await f.apply(f.open())).status, 'restored'); assert.equal(f.saves, 0);
  assert.equal(f.traffic.filter(row => row.url.endsWith('/image/restore/restore')).length, writes);
});

test('replacement pending operation after confirmation cannot redirect recovery to another proposal', async t => {
  const f = await fixture(t); await f.hideArchive(); f.host = async () => {}; await assert.rejects(f.apply(f.open())); await f.reload(); f.host = f.persist;
  const load = f.journal.loadHistoricalChatMutation; let calls = 0;
  const wrong = await createHistoricalChatMutation({ ...f.journal.record.proposal, fileHash: 'b'.repeat(64) });
  f.journal.loadHistoricalChatMutation = async (...args) => ++calls === 3 ? wrong : load(...args);
  const writes = f.recipeCalls.length;
  await assert.rejects(f.apply(f.open()), error => error.state === 'needs_review'); assert.equal(f.saves, 1); assert.equal(f.recipeCalls.length, writes);
});

test('server changes after preview invalidate the confirmed view before file writes', async t => {
  const f = await fixture(t), s = f.open(), view = await s.preview();
  const raw = await fs.readFile(f.file, 'utf8'), lines = raw.trimEnd().split('\n'), header = JSON.parse(lines[0]);
  header.chat_metadata.story_director_liminale.characterDrafts.items[0].future.note = 'changed on another device'; lines[0] = JSON.stringify(header);
  await fs.writeFile(f.file, lines.join('\n') + '\n');
  await assert.rejects(s.restore({ confirmed: true, dependenciesAccepted: true, expectedDigest: view.digest }), error => error.state === 'not_started');
  assert.equal(f.recipeCalls.length, 0); assert.equal(f.saves, 0); assert.equal(f.traffic.some(row => row.url.endsWith('/image/restore/restore')), false);
});

test('old backend and partial recipe failure never submit a native save', async t => {
  const f = await fixture(t), fetch = f.fullFetch;
  const s = f.open({ fetchImpl: (url, options) => url.endsWith('/recipe/restore') ? Response.json({ ok: false }, { status: 404 }) : fetch(url, options) });
  await assert.rejects(f.apply(s), error => error.state === 'needs_review'); assert.equal(f.saves, 0); assert.equal(f.journal.record, null);
  assert.deepEqual(await fs.readFile(path.join(f.images, 'inline.png')), png);
});

test('successful server persistence with lost native acknowledgement is verified, not repeated', async t => {
  const f = await fixture(t); await f.hideArchive(); f.host = async () => { await f.persist(); throw Error('ack lost'); };
  assert.equal((await f.apply(f.open())).status, 'restored'); assert.equal(f.saves, 1); assert.equal(f.journal.record.phase, 'verified');
});

test('new local edit after recovery preview prevents retries from erasing it', async t => {
  const f = await fixture(t); await f.hideArchive(); f.host = async () => {}; await assert.rejects(f.apply(f.open())); await f.reload(); f.host = f.persist;
  const s = f.open(), view = await s.preview(); f.context.chatMetadata.story_director_liminale.characterDrafts.items[0].future.note = 'user change';
  await assert.rejects(s.restore({ confirmed: true, dependenciesAccepted: true, expectedDigest: view.digest })); assert.equal(f.saves, 1);
  assert.equal(f.context.chatMetadata.story_director_liminale.characterDrafts.items[0].future.note, 'user change');
});
