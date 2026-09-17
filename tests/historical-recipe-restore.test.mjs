import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { historicalRecipeRestoreFixture as fixture } from './helpers/historical-recipe-restore-fixture.mjs';
import { captureStoryboardChatEvidence } from '../qianmu-storyboard-chat-evidence.js';
import { vibeDigest } from '../qianmu-vibe-file.js';
const consent = view => ({ confirmed: true, scope: view.scope, expectedDigest: view.digest });
const gate = () => { let release; const promise = new Promise(done => release = done); return { promise, release }; };
const archives = async f => Promise.all((await fs.readdir(f.archive)).sort().map(async name => [name, await fs.readFile(path.join(f.archive, name), 'utf8')]));
async function retainOldArchives(f) {
  for (const item of f.source.recipes.filter(row => row.origin === 'server-archive')) {
    const file = path.join(f.archive, item.reference.id + '.json'); assert.equal(path.dirname(file), f.archive);
    await fs.rename(file, file + '.retained'); // Only known fixture files; production never moves originals.
  }
}

test('preview is offline and explicit digest/scope/confirmation gates every archive write', async t => {
  const f = await fixture(t), bytes = await fs.readFile(f.file), saved = await archives(f), session = f.openRecipe();
  await assert.rejects(session.restore({ confirmed: true }));
  const view = await session.preview(); assert.equal(view.archiveRecipes, 1); assert.equal(view.inlineRecipes, 1);
  assert.equal(view.ready, true); assert.equal(view.metadataRestored, false); assert.equal(view.originalsVerified, false);
  for (const patch of [{ confirmed: false }, { scope: 'all' }, { expectedDigest: '0'.repeat(64) }]) await assert.rejects(session.restore({ ...consent(view), ...patch }));
  assert.equal(f.recipeCalls.length, 0); assert.deepEqual(await fs.readFile(f.file), bytes); assert.deepEqual(await archives(f), saved);
});

test('missing archived recipe gets exact detached reference mapping without changing inline originals or live metadata', async t => {
  const f = await fixture(t, { prepare: f => { f.rows[1].snapshotRef = 'legacy-local-retained'; f.rows[1].future = { whitespace: '  keep  ', zero: 0 }; } });
  const bytes = await fs.readFile(f.file), current = structuredClone(f.current), source = structuredClone(f.source); await retainOldArchives(f);
  const session = f.openRecipe(), view = await session.preview(), result = await session.restore(consent(view));
  const old = source.saved.storyboardImages[1], updated = result.proposedSaved.storyboardImages[1];
  assert.notEqual(updated.snapshotServerRef.id, old.snapshotServerRef.id);
  assert.deepEqual(updated, { ...old, snapshotServerRef: result.archiveReceipts[0].reference });
  assert.deepEqual(result.proposedSaved.storyboardImages[0], source.saved.storyboardImages[0]);
  assert.deepEqual(result.proposedSaved.characterDrafts, source.saved.characterDrafts); assert.deepEqual(result.proposedSaved.storyboardCollections, source.saved.storyboardCollections);
  assert.deepEqual(result.changedFields, ['storyboardImages']); assert.equal(result.archiveRecipesVerified, 1); assert.equal(result.inlineRecipesPreserved, 1);
  for (const key of ['metadataRestored', 'originalsVerified', 'dependenciesRestored', 'restoreSupported']) assert.equal(result[key], false);
  assert.deepEqual(result.requiredStages, ['verified-originals', 'dependency-review', 'durable-host-save']);
  const { digest, ...core } = result; assert.equal(digest, await vibeDigest(JSON.stringify(core)));
  assert.deepEqual(f.current, current); assert.deepEqual(f.source, source); assert.deepEqual(await fs.readFile(f.file), bytes);
  assert.equal(f.recipeCalls.length, 1); assert.equal(f.recipeCalls[0].headers.Authorization, undefined); assert.equal(f.recipeCalls[0].headers['X-CSRF-Token'], 'fixture');
  result.proposedSaved.characterDrafts.items[0].future.note = 'caller mutation'; result.before.storyboardImages.pop();
  assert.deepEqual(f.current, current); assert.deepEqual(f.source, source);
  await assert.rejects(session.restore(consent(view)), /确认/);
});

test('existing same reference reused with zero metadata changes; no claims about host saving or workflow readiness', async t => {
  const f = await fixture(t), before = await archives(f), session = f.openRecipe(), view = await session.preview();
  const result = await session.restore(consent(view)); assert.deepEqual(result.changedFields, []); assert.deepEqual(result.proposedSaved, f.current.saved);
  assert.deepEqual(await archives(f), before); assert.equal(result.archiveReceipts[0].reference.id, f.rows[1].snapshotServerRef.id);
});

test('local-only rows/order survive while missing historical rows, raw drafts and albums are proposed', async t => {
  const f = await fixture(t); f.current.saved = { storyboardImages: [{ id: 'local', createdAt: 9, extra: 0 }], storyboardCollections: [{ id: 'local-album', name: '原册' }] };
  const before = structuredClone(f.current.saved), session = f.openRecipe(), view = await session.preview(), result = await session.restore(consent(view));
  assert.deepEqual(result.proposedSaved.storyboardImages.map(row => row.id), ['local', 'inline', 'server']);
  assert.deepEqual(result.proposedSaved.storyboardImages[0], before.storyboardImages[0]);
  assert.deepEqual(result.changedFields, ['storyboardImages', 'storyboardCollections', 'characterDrafts']);
  assert.equal(result.proposedSaved.characterDrafts.items[0].future.note, ' preserve exact fields '); assert.deepEqual(f.current.saved, before);
});

test('absent saved fields remain absent in before and are not fabricated in the live source', async t => {
  const f = await fixture(t); f.current.saved = {}; const session = f.openRecipe(), view = await session.preview(), result = await session.restore(consent(view));
  assert.deepEqual(result.before, {}); assert.deepEqual(f.current.saved, {}); assert.deepEqual(result.proposedSaved, f.source.saved);
});

test('a consumer can save resolved proposal to an isolated chat and normal server-backed reading returns every original field', async t => {
  const f = await fixture(t); await retainOldArchives(f); const session = f.openRecipe(), view = await session.preview(), result = await session.restore(consent(view));
  const original = f.source.recipes[1].snapshot;
  // Explicit TEST consumer, not an implemented production host transaction.
  f.rows.splice(0, f.rows.length, ...structuredClone(result.proposedSaved.storyboardImages)); f.saved = { ...result.proposedSaved, storyboardImages: f.rows }; await f.write();
  const { gallerySha256, ...base } = f.request();
  const read = await f.recipes.read(f.req, { ...base, selection: { recordId: 'server', createdAt: 2, gallerySha256 } });
  assert.deepEqual(read.snapshot, original); assert.equal(read.snapshot.payload.parameters.workflow.nodes.length, 120); assert.equal(read.origin, 'server-archive');
});

test('same-ID record, album or draft conflicts reject whole batch before recipe requests', async t => {
  for (const change of [f => f.current.saved.storyboardImages[0].future = true, f => f.current.saved.storyboardCollections[0].name = 'edited',
    f => f.current.saved.characterDrafts.items[0].future.note = 'edited']) {
    const f = await fixture(t); change(f); await assert.rejects(f.openRecipe().preview(), /冲突/); assert.equal(f.recipeCalls.length, 0);
  }
});

test('wrong account, same-named other character and changed body rejected before any import', async t => {
  const f = await fixture(t);
  for (const options of [{ namespace: 'st-user:bob' }, { target: { ...f.target, avatar: 'Other.png' } }]) await assert.rejects(f.openRecipe(options).preview());
  f.current.evidence = await captureStoryboardChatEvidence([{ mes: 'different' }], f.target.chatId);
  await assert.rejects(f.openRecipe().preview(), /正文/); assert.equal(f.recipeCalls.length, 0);
});

test('partial original package cannot imply complete draft/album restoration scope', async t => {
  const f = await fixture(t, { recordIds: ['server'] }); await assert.rejects(f.openRecipe().preview(), /完整单聊天/); assert.equal(f.recipeCalls.length, 0);
});

test('broken package and invalid lifecycle inputs fail before source reads or file writes', async t => {
  const f = await fixture(t);
  for (const options of [{ file: {} }, { guard: null }, { isCurrent: null }, { readCurrent: null }, { timeoutMs: 0 }]) assert.throws(() => f.openRecipe(options));
  await assert.rejects(f.openRecipe({ file: new Blob(['broken']) }).preview()); assert.equal(f.recipeCalls.length, 0);
});

test('target captured once; changing caller target cannot redirect later operations', async t => {
  const f = await fixture(t), target = structuredClone(f.target), session = f.openRecipe({ target }); target.avatar = 'Other.png';
  const view = await session.preview(), result = await session.restore(consent(view)); assert.deepEqual(result.target, f.target);
});

test('preview result mutation cannot alter stored consent digest or internally captured plan', async t => {
  const f = await fixture(t), session = f.openRecipe(), view = await session.preview(), digest = view.digest;
  view.target.avatar = 'Other.png'; view.archiveRecipes = 100; view.digest = '0'.repeat(64);
  await assert.rejects(session.restore(consent(view))); const result = await session.restore({ ...consent(view), expectedDigest: digest });
  assert.equal(result.archiveRecipesVerified, 1); assert.deepEqual(result.target, f.target);
});

test('changed source baseline after preview requires fresh confirmation even when merge remains compatible', async t => {
  const f = await fixture(t), session = f.openRecipe(), view = await session.preview(); f.current.saved.storyboardImages.push({ id: 'new-local', createdAt: 8 });
  await assert.rejects(session.restore(consent(view)), /变化/); assert.equal(f.recipeCalls.length, 0);
  await assert.rejects(session.restore(consent(view)), /确认/); const fresh = await session.preview(), result = await session.restore(consent(fresh));
  assert.equal(result.proposedSaved.storyboardImages.at(-1).id, 'new-local');
});

test('failure on later archive returns only acknowledged receipts, no partially applicable proposal, and retains earlier file', async t => {
  const f = await fixture(t, { extraArchives: 1 }); await retainOldArchives(f); let posts = 0;
  const before = await fs.readFile(f.file), session = f.openRecipe({ fetchImpl: async (...args) => { if (++posts === 2) throw Error('second failed'); return f.restoreFetch(...args); } });
  const view = await session.preview(); let failure;
  try { await session.restore(consent(view)); assert.fail(); } catch (error) { failure = error; }
  assert.equal(failure.recipesState, 'needs_review'); assert.equal(failure.completed.length, 1); assert.equal(failure.proposedSaved, null);
  assert.equal((await fs.readdir(f.archive)).length, 3); assert.deepEqual(await fs.readFile(f.file), before);
  await assert.rejects(session.preview()); assert.equal(posts, 2);
  const retry = f.openRecipe(), fresh = await retry.preview(), result = await retry.restore(consent(fresh));
  assert.equal(result.archiveRecipesVerified, 2); assert.equal(result.archiveReceipts[0].reference.id, failure.completed[0].reference.id);
  assert.equal((await fs.readdir(f.archive)).length, 4);
});

test('lost response after actual write is not adopted; new explicit session reuses existing file', async t => {
  const f = await fixture(t); await retainOldArchives(f);
  const session = f.openRecipe({ fetchImpl: async (...args) => { await f.restoreFetch(...args); throw Error('lost acknowledgement'); } });
  const view = await session.preview(); await assert.rejects(session.restore(consent(view)), error => error.recipesState === 'needs_review' && !error.completed.length && error.proposedSaved === null);
  const names = await fs.readdir(f.archive), newName = names.find(name => name.endsWith('.json'));
  const retry = f.openRecipe(), result = await retry.restore(consent(await retry.preview()));
  assert.equal(result.archiveReceipts[0].reference.id + '.json', newName); assert.deepEqual(await fs.readdir(f.archive), names);
});

test('live edit after first archive stops the batch without overwriting the edit or submitting second archive', async t => {
  const f = await fixture(t, { extraArchives: 1 });
  const session = f.openRecipe({ fetchImpl: async (...args) => { const reply = await f.restoreFetch(...args); f.current.saved.characterDrafts.items[0].future.note = 'edited during save'; return reply; } });
  const view = await session.preview(); await assert.rejects(session.restore(consent(view)), error => error.recipesState === 'needs_review' && error.proposedSaved === null);
  assert.equal(f.recipeCalls.length, 1); assert.equal(f.current.saved.characterDrafts.items[0].future.note, 'edited during save');
});

test('late response after close settles promptly and cannot continue next recipe', async t => {
  const f = await fixture(t, { extraArchives: 1 }), entered = gate(), release = gate();
  const session = f.openRecipe({ fetchImpl: async (...args) => { const reply = await f.restoreFetch(...args); entered.release(); await release.promise; return reply; } });
  const view = await session.preview(), pending = session.restore(consent(view)); await entered.promise; session.close();
  await assert.rejects(pending, { recipesState: 'needs_review' }); release.release(); await new Promise(done => setTimeout(done, 10)); assert.equal(f.recipeCalls.length, 1);
});

test('whole-stage timeout, close and parent abort cover hung source resolver with no late upload', async t => {
  for (const mode of ['timeout', 'close', 'abort']) {
    const f = await fixture(t), waiting = gate(), controller = new AbortController();
    const session = f.openRecipe({ readCurrent: () => waiting.promise, timeoutMs: mode === 'timeout' ? 25 : 30000, signal: controller.signal });
    const pending = session.preview(); if (mode === 'close') session.close(); else if (mode === 'abort') controller.abort();
    await assert.rejects(pending, { recipesState: 'not_started' }); waiting.release(f.current); await new Promise(done => setTimeout(done, 5)); assert.equal(f.recipeCalls.length, 0);
  }
});

test('false guard, invalid live context, already-aborted parent and overlapping previews do not reach backend', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.openRecipe({ signal: controller.signal }).preview());
  await assert.rejects(f.openRecipe({ guard: () => false }).preview());
  await assert.rejects(f.openRecipe({ readCurrent: async () => ({ ...f.current, namespace: 'st-user:bob' }) }).preview());
  const waiting = gate(), session = f.openRecipe({ guard: () => waiting.promise }), pending = session.preview();
  await assert.rejects(session.preview(), /正在进行/); waiting.release(true); await pending; assert.equal(f.recipeCalls.length, 0);
});

test('all-inline and empty bundles preserve raw fields without recipe backend access', async t => {
  for (const empty of [false, true]) {
    const f = await fixture(t, { prepare: f => f.rows.splice(empty ? 0 : 1) });
    const session = f.openRecipe(), view = await session.preview(), result = await session.restore(consent(view));
    assert.equal(result.archiveRecipesVerified, 0); assert.equal(f.recipeCalls.length, 0); assert.equal(result.inlineRecipesPreserved, empty ? 0 : 1);
    assert.deepEqual(result.proposedSaved, f.saved); assert.deepEqual(result.changedFields, []);
  }
});

test('old backend fails explicitly without fallback to inline inflation or partial metadata proposal', async t => {
  const f = await fixture(t), before = structuredClone(f.current);
  const session = f.openRecipe({ fetchImpl: async () => new Response('old', { status: 404 }) }), view = await session.preview();
  await assert.rejects(session.restore(consent(view)), error => error.recipesState === 'needs_review' && error.proposedSaved === null && error.cause.message.includes('新版配套后端'));
  assert.deepEqual(f.current, before);
});
