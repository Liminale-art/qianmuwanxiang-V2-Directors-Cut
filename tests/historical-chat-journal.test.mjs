import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalChatSaveFixture as fixture, gate } from './helpers/historical-chat-save-fixture.mjs';
import { createHistoricalChatMutation, inspectHistoricalChatMutation, inspectHistoricalChatSaveProposal, historicalChatMutationNext } from '../qianmu-historical-chat-journal.js';

test('journal retains three complete raw fields, exact owner/target and digest-only body evidence', async t => {
  const f = await fixture(t), row = await createHistoricalChatMutation(f.proposal, { now: () => 7 });
  assert.equal(row.createdAt, 7); assert.equal(row.phase, 'prepared'); assert.equal(row.revision, 1);
  assert.deepEqual(row.proposal, f.proposal); assert.deepEqual(await inspectHistoricalChatMutation(row), row);
  assert.ok(!JSON.stringify(row).includes('PRIVATE_HISTORY')); assert.ok(!JSON.stringify(row).includes('PRIVATE_KEY'));
  row.proposal.after.characterDrafts.items[0].future.note = 'new'; assert.notEqual(f.proposal.after.characterDrafts.items[0].future.note, 'new');
});
test('proposal detaches all original fields before asynchronous validation', async t => {
  const f = await fixture(t), before = structuredClone(f.proposal), pending = inspectHistoricalChatSaveProposal(f.proposal);
  f.proposal.after.storyboardImages.pop(); f.proposal.chatEvidence.messages.pop(); f.proposal.target.avatar = 'Other.png';
  assert.deepEqual(await pending, before);
});
test('journal rejects malformed, other-account and credential-bearing data without trimming', async t => {
  const f = await fixture(t);
  for (const patch of [{ namespace: 'bob' }, { extra: true }, { fileHash: '' }, { before: {} }, { after: { storyboardImages: [] } },
    { after: { ...f.proposal.after, imagegen: {} } }, { after: { ...f.proposal.after, storyboardImages: [undefined] } },
    { after: { ...f.proposal.after, storyboardCollections: [{ apiKey: 'PRIVATE' }] } }])
    await assert.rejects(createHistoricalChatMutation({ ...f.proposal, ...patch }));
});
test('modified raw fields, evidence, target, digest or envelope cannot be loaded as a valid record', async t => {
  const f = await fixture(t), good = await createHistoricalChatMutation(f.proposal);
  for (const change of [r => r.proposal.after.storyboardImages.pop(), r => r.proposal.target.avatar = 'Other.png',
    r => r.proposal.chatEvidence.messages.pop(), r => r.proposalDigest = 'a'.repeat(64), r => r.namespace = 'st-user:bob',
    r => r.extra = true, r => r.revision = 0, r => r.updatedAt = -1, r => r.phase = 'finished']) {
    const row = structuredClone(good); change(row); await assert.rejects(inspectHistoricalChatMutation(row));
  }
});
test('phases record observations with monotonic revision/time but never permit rollback or verified replay', async t => {
  const f = await fixture(t), a = await createHistoricalChatMutation(f.proposal, { now: () => 50 });
  const b = historicalChatMutationNext(a, 'submitted', 3), c = historicalChatMutationNext(b, 'uncertain', 51), d = historicalChatMutationNext(c, 'submitted', 52), e = historicalChatMutationNext(d, 'verified', 53);
  assert.equal(b.updatedAt, 50); assert.equal(e.revision, 5); assert.equal(a.phase, 'prepared');
  assert.throws(() => historicalChatMutationNext(e, 'submitted', 60)); assert.throws(() => historicalChatMutationNext(a, 'prepared', 60));
  assert.throws(() => historicalChatMutationNext(a, 'submitted', NaN));
});

// Contract-matching memory double for coordinator error/race tests. Real IDB
// transactions, migration, persistence and cross-tab races are covered in Edge.
export function memoryHistoricalJournal() {
  let record = null;
  return {
    calls: [], get record() { return structuredClone(record); },
    async loadHistoricalChatMutation(namespace, { isCurrent = () => true } = {}) { assert.ok(isCurrent()); return record?.namespace === namespace ? structuredClone(record) : null; },
    async prepareHistoricalChatMutation(input, { confirmed, isCurrent } = {}) { assert.equal(confirmed, true); assert.ok(isCurrent()); assert.equal(record, null); this.calls.push('prepared'); record = await inspectHistoricalChatMutation(input); return structuredClone(record); },
    async updateHistoricalChatMutation(input, phase, { isCurrent } = {}) { assert.ok(isCurrent()); assert.deepEqual(record, input); this.calls.push(phase); record = historicalChatMutationNext(input, phase, Date.now()); return structuredClone(record); },
  };
}
test('durable write-ahead prepared/submitted commits before any local mutation or native call', async t => {
  const f = await fixture(t), journal = memoryHistoricalJournal(), before = structuredClone(f.store), prepare = journal.prepareHistoricalChatMutation;
  journal.prepareHistoricalChatMutation = async function (...args) { assert.deepEqual(f.store, before); assert.equal(f.saves, 0); return prepare.apply(this, args); };
  f.host = async () => { assert.equal(journal.record.phase, 'submitted'); await f.persist(); };
  const result = await f.open({ journal }).save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' });
  assert.equal(result.status, 'saved'); assert.equal(result.durableJournal, true); assert.deepEqual(journal.calls, ['prepared', 'submitted', 'verified']);
});
test('journal unavailable/quota failure stops before modifying live fields or dispatching host write', async t => {
  const f = await fixture(t), before = structuredClone(f.store), journal = memoryHistoricalJournal(); journal.prepareHistoricalChatMutation = async () => { throw Error('QuotaExceededError'); };
  await assert.rejects(f.open({ journal }).save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' })); assert.equal(f.saves, 0); assert.deepEqual(f.store, before);
});
test('submitted journal update failure keeps prepared intent and leaves live fields untouched', async t => {
  const f = await fixture(t), before = structuredClone(f.store), journal = memoryHistoricalJournal(); journal.updateHistoricalChatMutation = async () => { throw Error('disk failed'); };
  const result = await f.open({ journal }).save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' });
  assert.equal(result.status, 'unconfirmed'); assert.equal(result.durableJournal, true); assert.equal(journal.record.phase, 'prepared'); assert.equal(f.saves, 0); assert.deepEqual(f.store, before);
});
test('refresh recovery only reads; explicit retry can reapply unchanged before after fresh server/body checks', async t => {
  const f = await fixture(t), journal = memoryHistoricalJournal(); f.host = async () => {};
  const a = f.open({ journal }); await a.save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' }); a.close();
  Object.assign(f.store, structuredClone(f.proposal.before)); const b = f.open({ journal }), result = await b.recover();
  assert.equal(result.reason, 'confirmation_required'); assert.equal(result.durableJournal, true); assert.equal(f.saves, 1); assert.deepEqual(f.store.storyboardImages, f.proposal.before.storyboardImages);
  assert.equal((await b.retry()).status, 'unconfirmed'); assert.equal(f.saves, 1); f.host = f.persist;
  assert.equal((await b.retry({ confirmed: true })).status, 'saved'); assert.equal(f.saves, 2); assert.deepEqual(f.store.characterDrafts, f.proposal.after.characterDrafts);
});
test('refresh of completed save rechecks server and marks journal without repeating host save', async t => {
  const f = await fixture(t), journal = memoryHistoricalJournal(), a = f.open({ journal });
  await a.save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' }); a.close();
  assert.equal((await f.open({ journal }).recover()).status, 'saved'); assert.equal(f.saves, 1);
});
test('fresh recovery of another precise chat is rejected without adoption or writes', async t => {
  const f = await fixture(t), journal = memoryHistoricalJournal(), p = structuredClone(f.proposal); p.target.avatar = 'Other.png';
  await journal.prepareHistoricalChatMutation(await createHistoricalChatMutation(p), { confirmed: true, isCurrent: () => true });
  const s = f.open({ journal }); await assert.rejects(s.recover()); assert.equal(s.pending(), null); assert.equal(f.saves, 0);
});
test('recovery refuses edited local values and never overwrites an unrelated server update on retry', async t => {
  for (const mode of ['local', 'server', 'body']) {
    const f = await fixture(t), journal = memoryHistoricalJournal(); f.host = async () => {};
    const a = f.open({ journal }); await a.save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' }); a.close();
    Object.assign(f.store, structuredClone(f.proposal.before));
    if (mode === 'local') f.store.storyboardCollections[0].name = 'new edit';
    else { if (mode === 'body') f.messages[0].mes = 'changed'; else f.saved.characterDrafts.items[0].future.note = 'changed'; await f.write(); }
    const b = f.open({ journal }); assert.equal((await b.recover()).status, 'unconfirmed'); assert.equal((await b.retry({ confirmed: true })).status, 'unconfirmed'); assert.equal(f.saves, 1);
  }
});
test('new save cannot replace an existing durable record, including verified records', async t => {
  const f = await fixture(t), journal = memoryHistoricalJournal(); await f.open({ journal }).save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' });
  await assert.rejects(f.open({ journal }).save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' })); assert.equal(f.saves, 1);
});
test('a committed journal followed by close leaves a recoverable record but no late host write', async t => {
  const f = await fixture(t), journal = memoryHistoricalJournal(), wait = gate(), entered = gate(), original = journal.prepareHistoricalChatMutation;
  journal.prepareHistoricalChatMutation = async function (...args) { const row = await original.apply(this, args); entered.release(); await wait.promise; return row; };
  const a = f.open({ journal }), pending = a.save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' }); await entered.promise; a.close();
  await assert.rejects(pending); wait.release(); await new Promise(done => setTimeout(done, 15)); assert.equal(f.saves, 0); assert.equal(journal.record.phase, 'prepared'); assert.equal(a.pending(), null);
});
test('native commit with failed journal acknowledgement is recovered through fresh server readback', async t => {
  const f = await fixture(t), journal = memoryHistoricalJournal(), update = journal.updateHistoricalChatMutation;
  journal.updateHistoricalChatMutation = async function (row, phase, options) { if (phase === 'verified') throw Error('journal confirmation lost'); return update.call(this, row, phase, options); };
  const a = f.open({ journal }), result = await a.save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' });
  assert.equal(result.status, 'unconfirmed'); assert.equal(result.durableJournal, true); assert.equal(f.saves, 1); assert.equal(journal.record.phase, 'submitted'); a.close();
  journal.updateHistoricalChatMutation = update; assert.equal((await f.open({ journal }).recover()).status, 'saved'); assert.equal(f.saves, 1);
});
test('recovered stale local before with already committed server after asks reload instead of reapplying', async t => {
  const f = await fixture(t), journal = memoryHistoricalJournal(), a = f.open({ journal });
  await a.save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' }); a.close(); Object.assign(f.store, structuredClone(f.proposal.before));
  const b = f.open({ journal }); await b.recover(); assert.equal((await b.retry({ confirmed: true })).reason, 'reload_required'); assert.equal(f.saves, 1); assert.deepEqual(f.store.storyboardImages, f.proposal.before.storyboardImages);
});
test('verified local journal never authorizes replay when server contents revert to before', async t => {
  const f = await fixture(t), journal = memoryHistoricalJournal(), a = f.open({ journal });
  await a.save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' }); a.close(); Object.assign(f.store, structuredClone(f.proposal.before)); await f.persist();
  const b = f.open({ journal }); await b.recover(); assert.equal((await b.retry({ confirmed: true })).status, 'unconfirmed'); assert.equal(f.saves, 1);
});
test('local changes while journal commits are retained; prepared record alone is not save authority', async t => {
  const f = await fixture(t), journal = memoryHistoricalJournal(), update = journal.updateHistoricalChatMutation;
  journal.updateHistoricalChatMutation = async function (...args) { const row = await update.apply(this, args); f.store.storyboardCollections[0].name = 'new edit during IDB'; return row; };
  const result = await f.open({ journal }).save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' }); assert.equal(result.status, 'unconfirmed'); assert.equal(f.saves, 0); assert.equal(f.store.storyboardCollections[0].name, 'new edit during IDB');
});
test('server change while the durable journal commits is rechecked before any native write', async t => {
  const f = await fixture(t), journal = memoryHistoricalJournal(), update = journal.updateHistoricalChatMutation;
  journal.updateHistoricalChatMutation = async function (...args) { const row = await update.apply(this, args); f.saved.characterDrafts.items[0].future.note = 'other-device during IDB'; await f.write(); return row; };
  const before = structuredClone(f.store), result = await f.open({ journal }).save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' });
  assert.equal(result.status, 'unconfirmed'); assert.equal(f.saves, 0); assert.deepEqual(f.store, before);
});
test('stale submitted journal revision cannot authorize retry after another page advances it', async t => {
  const f = await fixture(t), journal = memoryHistoricalJournal(); f.host = async () => {};
  const a = f.open({ journal }); await a.save(f.proposal, { confirmed: true, scope: 'historical-chat-metadata-only' });
  await journal.updateHistoricalChatMutation(journal.record, 'submitted', { isCurrent: () => true });
  assert.equal((await a.retry({ confirmed: true })).status, 'unconfirmed'); assert.equal(f.saves, 1);
});
