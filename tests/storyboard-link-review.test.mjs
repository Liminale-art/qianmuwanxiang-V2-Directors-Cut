import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createStoryboardLinkReview } from '../qianmu-storyboard-link-review.js';
import * as mutation from '../qianmu-storyboard-package-mutation.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

function fixture() {
  const record = { id: 'image-1', url: '/user/images/a.png', floor: null, inline: false, messageHash: 'old',
    recipe: { floor: 7, prompt: 'original recipe' }, snapshot: { chatKey: 'old', payload: { prompt: 'original' } },
    restoreLinkReview: { version: 1, sourceFloor: 7, sourceChatKey: 'old', sourceFingerprint: 'source-bundle', reason: 'unverified-message' } };
  const records = [record, { id: 'other', tags: ['keep'] }];
  const messages = [{ mes: 'user', is_user: true }, { mes: 'first\nsecond', name: 'Character', send_date: '2026-09-08', swipe_id: 0 }];
  const session = createStoryboardLinkReview({ recordId: record.id, records: () => records, messages: () => messages, chatKey: 'chat', paragraphs: text => text.split('\n'), now: () => 10 });
  const select = () => { session.selectFloor(1); session.selectParagraph(1); };
  return { record, records, messages, session, select };
}
test('explicit floor and paragraph confirmation edits display links only and retains source receipt', async () => {
  const f = fixture(), before = structuredClone(f.records);
  assert.equal(f.session.floors().count, 1); assert.equal(f.session.floors().rows[0].floor, 1);
  await assert.rejects(f.session.prepare({ confirmed: true }), /正文|选层/);
  f.session.selectFloor(1); await assert.rejects(f.session.prepare({ confirmed: true }), /段落/);
  f.session.selectParagraph(1); await assert.rejects(f.session.prepare(), /确认/);
  const p = await f.session.prepare({ confirmed: true }), next = p.draft.chat.storyboardImages[0];
  assert.deepEqual(f.records, before); assert.deepEqual(p.draft.settings, {}); assert.equal(p.fileHash.length, 64);
  assert.equal(next.floor, 1); assert.equal(next.lastKnownFloor, 1); assert.equal(next.inline, true); assert.equal(next.restoreLinkReview, undefined);
  assert.equal(next.paragraphAnchor.paragraphIndex, 1); assert.equal(next.paragraphAnchor.paragraphText, 'second');
  assert.deepEqual(next.recipe, before[0].recipe); assert.deepEqual(next.snapshot, before[0].snapshot);
  assert.deepEqual(next.restoreLinkHistory[0].review, before[0].restoreLinkReview);
  assert.equal(next.restoreLinkHistory[0].previous.messageHash, 'old'); assert.equal(next.restoreLinkHistory[0].target.sha256.length, 64);
  assert.deepEqual(p.draft.chat.storyboardImages[1], before[1]);
});
test('user/system/invalid floors and implicit or invalid paragraph choices are never accepted', () => {
  const f = fixture(); f.messages.push({ mes: 'system', is_system: true });
  for (const floor of [0, 2, 3, -1, '1', 1.1]) assert.throws(() => f.session.selectFloor(floor), /正文楼层/);
  f.session.selectFloor(1); for (const index of [-1, 2, '1', 0.1]) assert.throws(() => f.session.selectParagraph(index), /段落/);
});
test('changed text, identity, swipe and generation reference invalidate frozen selection', async () => {
  for (const change of [m => m.mes = 'different', m => m.name = 'Other', m => m.swipe_id++, m => m.original_avatar = 'different.png', m => m.extra = { gen_id: 'new' }]) {
    const f = fixture(); f.select(); change(f.messages[1]); await assert.rejects(f.session.prepare({ confirmed: true }), /正文|候选/);
  }
});
test('image mutation, duplicate IDs and unrelated gallery changes cannot overwrite concurrent edits', async () => {
  const f = fixture(); f.select(); const draft = await f.session.prepare({ confirmed: true });
  f.records[1].tags.push('new'); assert.throws(draft.validateDraft, /阅片室已变化/);
  f.record.tags = ['edited']; assert.throws(() => f.session.validate(), /图片资料已变化/);
  const g = fixture(); g.records.push(structuredClone(g.record)); assert.throws(() => g.session.floors(), /图片资料/);
});
test('paged floors/paragraphs stay bounded; oversize text and paragraph histories fail without truncation', async () => {
  const f = fixture(); f.messages.push(...Array.from({ length: 70 }, () => ({ mes: 'text' })));
  assert.equal(f.session.floors().rows.length, 24); assert.equal(f.session.floors(2).rows.length, 23);
  f.messages[1].mes = Array.from({ length: 240 }, (_, i) => `p${i}`).join('\n');
  f.session.selectFloor(1); assert.equal(f.session.paragraphs(9).rows.at(-1).index, 239);
  f.messages[1].mes += '\nextra'; assert.throws(() => f.session.selectFloor(1), /240/);
  f.messages[1].mes = 'a'.repeat(2 * 1048576 + 1); assert.throws(() => f.session.selectFloor(1), /2 Mi/);
  const g = fixture(); g.record.restoreLinkHistory = Array.from({ length: 100 }, () => ({ old: true }));
  const session = createStoryboardLinkReview({ recordId: g.record.id, records: () => g.records, messages: () => g.messages, chatKey: 'chat', paragraphs: text => text.split('\n') });
  session.selectFloor(1); session.selectParagraph(0); await assert.rejects(session.prepare({ confirmed: true }), /100 条/);
});
test('journal patch can restore the exact pending link and original payload without regenerating', async () => {
  const f = fixture(); f.select(); const p = await f.session.prepare({ confirmed: true });
  const chat = { storyboardImages: f.records }, before = structuredClone(chat), settings = {};
  const row = await mutation.createStoryboardMutation({ namespace: 'st-user:test', chatKey: 'chat', fileHash: p.fileHash, settings, chat, draft: p.draft, now: () => 12 });
  assert.equal(row.patch.length, 1); assert.equal(row.patch[0].area, 'chat');
  mutation.applyStoryboardMutation(row, { settings, chat }); assert.equal(chat.storyboardImages[0].floor, 1);
  f.session.validateTarget();
  mutation.applyStoryboardMutation(row, { settings, chat }, 'before'); assert.deepEqual(chat, before);
});

async function production({ pending = false, changeAt = '', lock = true, saveFail = false, cancel = false } = {}) {
  const f = fixture(), state = { shotPlans: [] }, store = { storyboardImages: f.records }; let saved = null, writes = 0, rendered = 0, scheduler = 0, closed = 0;
  let outcome, phase, applyError, revision = 0; const notices = [];
  const modules = { storyboardPackageAssets: { createStoryboardPackageGuard: async () => ({ namespace: 'st-user:test', guard: async () => {} }) }, imageAdmission: {},
    storyboardPackageJournal: { createStoryboardPackageJournal: () => ({ hasMutation: async () => pending, prepareMutation: async row => { saved = row; if (changeAt === 'prepared') f.messages[1].mes = 'changed'; return row; }, updateMutation: async (_, value) => { phase = value; }, close: () => closed++ }) },
    storyboardPackageMutation: mutation, storyboardLinkReview: { createStoryboardLinkReview },
    storyboardLinkReviewView: { openStoryboardLinkReview: ({ session, apply }) => {
      session.selectFloor(1); session.selectParagraph(1);
      return { isOpen: true, close() {}, finished: Promise.resolve().then(async () => { if (cancel) return; try { outcome = await apply(); } catch (error) { applyError = error; } }) };
    } } };
  const context = vm.createContext({ console, structuredClone, storyboardImportPackage: {}, storyboardExportPackage: {}, storyboardState: () => state, getChatStore: () => store,
    getChatKey: () => 'chat', storyboardAdmissionEpoch: 1, featureRuntime: { load: async name => modules[name] },
    document: { getElementById: () => ({ classList: { contains: () => true } }) }, MODAL_ID: 'modal',
    storyboardActiveJobs: new Set(), storyboardQueue: [], navigator: { locks: { request: async (_, __, fn) => fn(lock ? {} : null) } },
    storyboardSafeUrl: url => url, ctx: () => ({ chat: f.messages }), storyboardLinkReviewParagraphs: text => text.split('\n'), applyQianmuIcons() {}, storyboardLinkReview: null,
    saveMetadata: async () => { writes++; if (changeAt === 'save') f.messages[1].mes = 'changed'; if (saveFail) throw new Error('write failed'); },
    storyboardScheduleInlineRender: () => scheduler++, renderModal: () => rendered++, toast: message => notices.push(message) });
  vm.runInContext(storyboardFunctionSource('storyboardReviewRecordLink'), context);
  await context.storyboardReviewRecordLink(f.record);
  return { f, store, saved, writes, rendered, scheduler, closed, outcome, phase, applyError, notices, busy: context.storyboardImportPackage.busy };
}
test('real index entry persists once under import lock and keeps a reversible journal', async () => {
  const r = await production(); assert.equal(r.outcome.applied, true); assert.equal(r.writes, 1); assert.equal(r.phase, 'applied'); assert.equal(r.scheduler, 1);
  assert.equal(r.store.storyboardImages[0].floor, 1); assert.equal(r.saved.patch.length, 1); assert.equal(r.closed, 1); assert.equal(r.busy, false);
});
test('real entry cancellation, pending journal, unavailable lock and stale selection never persist', async () => {
  for (const options of [{ cancel: true }, { pending: true }, { lock: false }, { changeAt: 'prepared' }]) {
    const r = await production(options); assert.equal(r.writes, 0); assert.equal(r.store.storyboardImages[0].inline, false); assert.equal(r.scheduler, 0);
  }
});
test('real entry reports uncertain save or changed narrative without claiming a completed insertion', async () => {
  for (const options of [{ saveFail: true }, { changeAt: 'save' }]) {
    const r = await production(options); assert.equal(r.writes, 1); assert.equal(r.phase, 'uncertain'); assert.equal(r.scheduler, 0); assert.match(r.applyError.message, /未确认/);
    assert.ok(r.saved.patch[0].before.value[0].restoreLinkReview);
  }
});
