import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { historicalChatSaveFixture as fixture, consent, gate } from './helpers/historical-chat-save-fixture.mjs';
import { createChatCharacterSaveSession } from '../qianmu-character-chat-save.js';
import { normalizeChatCharacterCollection } from '../qianmu-character-chat-batch.js';

test('native host saves exactly three selected fields and confirms raw server contents/body without replacing other modules', async t => {
  const f = await fixture(t), before = await fs.readFile(f.file, 'utf8'), store = f.store, imagegen = store.imagegen, another = f.context.chatMetadata.unrelated;
  const session = f.open(), result = await session.save(f.proposal, consent);
  assert.equal(result.status, 'saved'); assert.equal(result.metadataVerified, true); assert.equal(result.durableJournal, false); assert.equal(f.saves, 1); assert.equal(session.pending(), null);
  const after = await fs.readFile(f.file, 'utf8'), saved = JSON.parse(after.split('\n')[0]).chat_metadata;
  for (const key of Object.keys(f.proposal.after)) assert.deepEqual(saved.story_director_liminale[key], f.proposal.after[key]);
  assert.strictEqual(f.context.chatMetadata.story_director_liminale, store); assert.strictEqual(store.imagegen, imagegen); assert.strictEqual(f.context.chatMetadata.unrelated, another);
  assert.equal(after.slice(after.indexOf('\n')), before.slice(before.indexOf('\n')));
  assert.equal(saved.story_director_liminale.history, 'PRIVATE_HISTORY'); assert.equal(saved.unrelated.apiKey, 'PRIVATE_KEY');
  assert.ok(f.calls.every(row => row.headers.Authorization === undefined && row.headers['X-CSRF-Token'] === 'fixture'));
  assert.deepEqual(f.calls.map(row => row.url.split('/').at(-1)), ['state', 'evidence', 'state', 'state', 'evidence', 'state']);
});

test('exact no-op gets verified without invoking native save or inventing pending intent', async t => {
  const f = await fixture(t), session = f.open(); f.proposal.after = structuredClone(f.proposal.before);
  assert.equal((await session.save(f.proposal, consent)).status, 'unchanged'); assert.equal(f.saves, 0); assert.equal(session.pending(), null);
});

test('consent, scope, target/account, plain JSON, allowed fields and non-removal enforced before host writes', async t => {
  const f = await fixture(t), session = f.open(); await assert.rejects(session.save(f.proposal));
  await assert.rejects(session.save(f.proposal, { ...consent, scope: 'all' }));
  for (const patch of [{ namespace: 'st-user:bob' }, { target: { ...f.target, avatar: 'Other.png' } }, { extra: true }, { fileHash: 'invalid' },
    { after: { ...f.proposal.after, imagegen: {} } }, { after: { storyboardImages: [] } }, { before: {} }, { after: { ...f.proposal.after, storyboardImages: new Array(2) } }])
    await assert.rejects(session.save({ ...f.proposal, ...patch }, consent));
  assert.equal(f.saves, 0); assert.equal(f.calls.length, 0);
});

test('proposal detached synchronously from caller edits during account/guard waits', async t => {
  const f = await fixture(t), wait = gate(), session = f.open({ guard: () => wait.promise }), after = structuredClone(f.proposal.after);
  const pending = session.save(f.proposal, consent); f.proposal.after.storyboardImages.pop(); f.proposal.target.avatar = 'Other.png'; wait.release(true);
  assert.equal((await pending).status, 'saved'); assert.deepEqual(f.store.storyboardImages, after.storyboardImages);
});

test('changed local baseline or body fails before server observation and mutation', async t => {
  for (const change of [f => f.store.storyboardImages.push({ id: 'local', createdAt: 7 }), f => f.context.chat[0].mes = 'edited']) {
    const f = await fixture(t); change(f); const before = structuredClone(f.store); await assert.rejects(f.open().save(f.proposal, consent));
    assert.equal(f.saves, 0); assert.equal(f.calls.length, 0); assert.deepEqual(f.store, before);
  }
});

test('server-only changes to gallery, album, raw draft or body refuse stale host save', async t => {
  for (const field of ['storyboardImages', 'storyboardCollections', 'characterDrafts', 'body']) {
    const f = await fixture(t), before = structuredClone(f.store);
    if (field === 'body') f.messages[0].mes = 'other-device body'; else if (field === 'characterDrafts') f.saved[field].items[0].future.note = 'other-device draft'; else f.saved[field].push({ id: 'other', name: 'other', createdAt: 7 });
    await f.write(); await assert.rejects(f.open().save(f.proposal, consent)); assert.equal(f.saves, 0); assert.deepEqual(f.store, before);
  }
});

test('local raw-field edit during remote preflight is not overwritten by the captured proposal', async t => {
  const f = await fixture(t), session = f.open({ fetchImpl: async (...args) => { const reply = await f.fetch(...args); f.store.characterDrafts.items[0].future.note = 'edited while waiting'; return reply; } });
  await assert.rejects(session.save(f.proposal, consent)); assert.equal(f.saves, 0); assert.equal(f.store.characterDrafts.items[0].future.note, 'edited while waiting');
});

test('server metadata change between state and evidence is caught by final state observation', async t => {
  const f = await fixture(t); let changed = false;
  const session = f.open({ fetchImpl: async (url, options) => { const reply = await f.fetch(url, options); if (url.endsWith('/evidence') && !changed) { changed = true; f.saved.storyboardCollections[0].name = 'changed in between'; await f.write(); } return reply; } });
  await assert.rejects(session.save(f.proposal, consent)); assert.equal(f.saves, 0);
});

test('incompatible or locked final field refuses all assignments, not just last failed field', async t => {
  const f = await fixture(t), before = structuredClone(f.store);
  Object.defineProperty(f.store, 'characterDrafts', { writable: false }); await assert.rejects(f.open().save(f.proposal, consent));
  assert.equal(f.saves, 0); assert.deepEqual(f.store, before);
});

test('swallowed native failure remains unconfirmed, only explicit retry can save after fresh server baseline checks', async t => {
  const f = await fixture(t); f.host = async () => {}; const session = f.open(), result = await session.save(f.proposal, consent);
  assert.equal(result.status, 'unconfirmed'); assert.deepEqual(session.pending().after, f.proposal.after); assert.equal(f.saves, 1);
  assert.equal((await session.retry()).status, 'unconfirmed'); assert.equal(f.saves, 1);
  f.host = f.persist; assert.equal((await session.retry({ confirmed: true })).status, 'saved'); assert.equal(f.saves, 2); assert.equal(session.pending(), null);
});

test('native throw after disk persistence is saved only when exact subsequent readback matches', async t => {
  const f = await fixture(t); f.host = async () => { await f.persist(); throw Error('lost native acknowledgement'); };
  assert.equal((await f.open().save(f.proposal, consent)).status, 'saved'); assert.equal(f.saves, 1);
});

test('native throw before commit preserves proposed local content and never automatically rolls it back', async t => {
  const f = await fixture(t), before = await fs.readFile(f.file); f.host = () => { throw Error('native refused'); };
  const session = f.open(), result = await session.save(f.proposal, consent); assert.equal(result.status, 'unconfirmed'); assert.equal(f.saves, 1);
  assert.deepEqual(f.store.storyboardImages, f.proposal.after.storyboardImages); assert.deepEqual(await fs.readFile(f.file), before);
});

test('host timeout retains shared exclusion until actual native promise settles; then verify is read-only', async t => {
  const f = await fixture(t), wait = gate(); let nativeSave;
  f.host = () => nativeSave = (async () => { await wait.promise; await f.persist(); })();
  const a = f.open({ hostTimeoutMs: 20 }), b = f.open(); const result = await a.save(f.proposal, consent);
  assert.equal(result.reason, 'host_pending'); await assert.rejects(b.save(f.proposal, consent)); await assert.rejects(a.retry({ confirmed: true }));
  // Wait for the actual file write, not a 25ms estimate that races the disk
  // under the full parallel suite. Timeout/lock assertions above stay intact.
  wait.release(); await nativeSave; assert.equal((await a.verify()).status, 'saved'); assert.equal(f.saves, 1);
});

test('character draft saver and three-field saver share host write exclusion', async t => {
  const f = await fixture(t), wait = gate(); f.host = async () => { await wait.promise; await f.persist(); };
  const historical = f.open({ hostTimeoutMs: 15 }); assert.equal((await historical.save(f.proposal, consent)).reason, 'host_pending');
  const character = await createChatCharacterSaveSession(f.options()); t.after(() => character.close());
  const after = normalizeChatCharacterCollection(f.store.characterDrafts, { namespace: f.namespace, chatKey: f.target.chatId }); after.revision++;
  await assert.rejects(character.save(after, { expectedRevision: after.revision - 1 }), /尚未结束/);
  wait.release(); await new Promise(done => setTimeout(done, 25)); assert.equal((await historical.verify()).status, 'saved');
});

test('three-field saver also refuses a still-pending character-only native write', async t => {
  const f = await fixture(t), wait = gate(), owner = { namespace: f.namespace, chatKey: f.target.chatId };
  f.store.characterDrafts = normalizeChatCharacterCollection(f.store.characterDrafts, owner); await f.persist();
  f.host = async () => { await wait.promise; await f.persist(); };
  const character = await createChatCharacterSaveSession({ ...f.options(), timeoutMs: 100 }); t.after(() => character.close());
  const after = structuredClone(f.store.characterDrafts); after.revision++;
  assert.equal((await character.save(after, { expectedRevision: after.revision - 1 })).reason, 'host_pending');
  await assert.rejects(f.open().save(f.proposal, consent), /尚未结束/); assert.equal(f.saves, 1);
  wait.release(); await new Promise(done => setTimeout(done, 25)); assert.equal((await character.verify()).status, 'saved');
});

test('closed session does not release host lock before late native completion or roll back staged data', async t => {
  const f = await fixture(t), entered = gate(), wait = gate(); f.host = async () => { entered.release(); await wait.promise; await f.persist(); };
  const a = f.open(), pending = a.save(f.proposal, consent); await entered.promise; a.close();
  assert.equal((await pending).status, 'unconfirmed'); const b = f.open(); await assert.rejects(b.save(f.proposal, consent));
  wait.release(); await new Promise(done => setTimeout(done, 25)); assert.equal(f.saves, 1); assert.deepEqual(f.store.storyboardImages, f.proposal.after.storyboardImages);
});

test('chat/account changes after native dispatch are never acknowledged or replayed into another chat', async t => {
  for (const mode of ['chat', 'account']) {
    const f = await fixture(t), entered = gate(), wait = gate(), originalStore = f.store;
    f.host = async () => { entered.release(); await wait.promise; }; const session = f.open(), pending = session.save(f.proposal, consent); await entered.promise;
    if (mode === 'chat') { f.epoch++; f.context = { ...f.context, chatId: 'Other', characters: [{ avatar: 'Other.png', chat: 'Other' }], chat: [], chatMetadata: { story_director_liminale: { storyboardImages: [] } } }; } else f.namespace = 'st-user:bob';
    wait.release(); assert.equal((await pending).status, 'unconfirmed'); assert.deepEqual(originalStore.storyboardImages, f.proposal.after.storyboardImages);
    if (mode === 'chat') { await assert.rejects(session.retry({ confirmed: true })); assert.deepEqual(f.context.chatMetadata.story_director_liminale.storyboardImages, []); }
    else assert.equal((await session.retry({ confirmed: true })).status, 'unconfirmed'); assert.equal(f.saves, 1);
  }
});

test('already persisted retry only verifies and never reissues the host call', async t => {
  const f = await fixture(t); f.host = async () => {}; const session = f.open(); await session.save(f.proposal, consent); await f.persist();
  assert.equal((await session.retry({ confirmed: true })).status, 'saved'); assert.equal(f.saves, 1);
});

test('retry refuses conflicting server contents or local edits, retaining both versions', async t => {
  for (const mode of ['server', 'local', 'body']) {
    const f = await fixture(t); f.host = async () => {}; const session = f.open(); await session.save(f.proposal, consent);
    if (mode === 'local') f.store.storyboardCollections[0].name = 'new local edit';
    else { if (mode === 'body') f.messages[0].mes = 'new server body'; else f.saved.characterDrafts.items[0].future.note = 'new server edit'; await f.write(); }
    assert.equal((await session.retry({ confirmed: true })).status, 'unconfirmed'); assert.equal(f.saves, 1);
  }
});

test('pending() is detached and current intent cannot be replaced by a second proposal', async t => {
  const f = await fixture(t); f.host = async () => {}; const session = f.open(); await session.save(f.proposal, consent);
  const snapshot = session.pending(); snapshot.after.storyboardImages.pop(); assert.deepEqual(session.pending().after, f.proposal.after);
  assert.equal((await session.save(f.proposal, consent)).status, 'unconfirmed'); assert.equal(f.saves, 1);
});

test('whole-operation deadline and close settle hung identity checks without late writes', async t => {
  for (const mode of ['guard-timeout', 'account-timeout', 'close']) {
    const f = await fixture(t), wait = gate(), options = { timeoutMs: 25 };
    if (mode === 'account-timeout') options.account = () => wait.promise; else options.guard = () => wait.promise;
    const session = f.open(options), pending = session.save(f.proposal, consent); if (mode === 'close') session.close();
    await assert.rejects(pending); wait.release(mode === 'account-timeout' ? f.namespace : true); await new Promise(done => setTimeout(done, 5));
    assert.equal(f.saves, 0); assert.equal(f.calls.length, 0); assert.equal(session.pending(), null);
  }
});

test('old backend or failed before-read cannot invoke host save; post-save failure is uncertain', async t => {
  const f = await fixture(t), session = f.open({ fetchImpl: async () => new Response('old', { status: 404 }) }); await assert.rejects(session.save(f.proposal, consent)); assert.equal(f.saves, 0);
  const g = await fixture(t), c = g.open({ fetchImpl: async (...args) => g.saves ? new Response('old', { status: 404 }) : g.fetch(...args) });
  assert.equal((await c.save(g.proposal, consent)).status, 'unconfirmed'); assert.equal(g.saves, 1);
});

test('missing gallery slot and malformed or credential-bearing proposals refuse rather than fabricate or trim', async t => {
  const f = await fixture(t), before = structuredClone(f.store); f.proposal.after.characterDrafts.items[0].future.apiKey = 'PRIVATE';
  await assert.rejects(f.open().save(f.proposal, consent)); assert.equal(f.saves, 0); assert.deepEqual(f.store, before);
  const g = await fixture(t); delete g.store.storyboardImages; await assert.rejects(g.open().save(g.proposal, consent)); assert.equal(g.saves, 0);
});
