import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as saves from '../qianmu-film-editor-save.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
function fixture() {
  const timeline = { timelineId: 'film', title: 'original', owner: { chatKey: 'a' }, updatedAt: 1, clips: [] };
  const page = { isConnected: true }, modal = { isConnected: true, classList: { contains: () => state.open }, querySelector: () => page };
  const calls = { remove: 0, confirm: 0, render: 0 }, notices = [];
  const state = vm.createContext({ ...saves, settings: {}, storyboardAdmissionEpoch: 1, chat: 'a', open: true, MODAL_ID: 'modal',
    document: { getElementById: () => modal }, getChatKey: () => state.chat,
    storyboardFilmRuntime: { timelines: [timeline] }, storyboardFilmEditor: null,
    confirmDialog: async () => { calls.confirm++; if (state.confirmGate) await state.confirmGate; return state.confirmed !== false; },
    storyboardEnsureFilmRuntime: async () => { if (state.loadGate) await state.loadGate; return { store: {
      remove: async () => { calls.remove++; },
      removeIfUnchanged: async (value, { guard }) => {
        if (state.transactionGate) await state.transactionGate;
        if (!guard() || state.diskChanged) return { deleted: [] };
        if (state.failure) throw Error('synthetic transaction failure');
        calls.remove++; if (state.commitGate) await state.commitGate; return { deleted: [value.timelineId] };
      },
    } }; },
    storyboardEnsureFilmPostproductionRuntime: async () => ({ store: { remove: async () => {} } }),
    renderModal: () => { calls.render++; }, toast: (text, level) => notices.push({ text, level }), console: { warn() {} },
  });
  vm.runInContext(storyboardFunctionSource('storyboardDeleteFilmTimeline'), state);
  return { timeline, page, modal, state, calls, notices, run: () => state.storyboardDeleteFilmTimeline('film') };
}
const tick = () => new Promise(r => setImmediate(r));

for (const phase of ['confirmGate', 'loadGate', 'transactionGate']) {
  for (const change of ['chat', 'account', 'epoch', 'close', 'page', 'revision']) {
    test(`film deletion stops ${change} during ${phase}`, async () => {
      const f = fixture(), gate = deferred(); f.state[phase] = gate.promise;
      const running = f.run(); await tick();
      if (change === 'chat') f.state.chat = 'b';
      if (change === 'account') f.state.settings = {};
      if (change === 'epoch') f.state.storyboardAdmissionEpoch++;
      if (change === 'close') f.state.open = false;
      if (change === 'page') f.page.isConnected = false;
      if (change === 'revision') f.state.storyboardFilmRuntime.timelines = [{ ...f.timeline, title: 'new', updatedAt: 2 }];
      gate.resolve(); await running;
      assert.equal(f.calls.remove, 0); assert.equal(f.calls.render, 0);
    });
  }
}
test('cancel never loads a destructive operation', async () => {
  const f = fixture(); f.state.confirmed = false; await f.run();
  assert.equal(f.calls.remove, 0); assert.equal(f.notices.length, 0);
});
test('current confirmed deletion removes the row and preserves originals', async () => {
  const f = fixture(); await f.run(); assert.equal(f.calls.remove, 1); assert.equal(f.calls.render, 1);
  assert.equal(f.state.storyboardFilmRuntime.timelines.length, 0); assert.match(f.notices.at(-1).text, /素材仍保留/);
});
test('duplicate deletion owns one confirmation and blocks a save for the same timeline', async () => {
  const f = fixture(), gate = deferred(); f.state.confirmGate = gate.promise;
  const first = f.run(); await tick();
  assert.equal(saves.isFilmEditorSaving(f.timeline), true);
  await f.run(); assert.equal(f.calls.confirm, 1);
  const result = await saves.saveFilmEditorSnapshot({ editor: f.timeline });
  assert.equal(result.status, 'busy'); gate.resolve(); await first;
  assert.equal(saves.isFilmEditorSaving(f.timeline), false);
});
test('a save in progress blocks deletion before a confirmation is shown', async () => {
  const f = fixture(), gate = deferred();
  const editor = { ...f.timeline, selections: [], postproduction: { subtitles: [], audio: { dialogue: [] } } };
  const saving = saves.saveFilmEditorSnapshot({ editor, readSources: () => ({ motionItems: [], stillRecords: [] }),
    canCommit: () => true, ensureRuntime: async () => { await gate.promise; throw Error('controlled end'); }, ensurePostproduction: async () => ({}) });
  await tick(); await f.run(); assert.equal(f.calls.confirm, 0); assert.equal(f.calls.remove, 0);
  gate.resolve(); await saving; assert.equal(saves.isFilmEditorSaving(editor), false);
});
test('newer persisted revision is not removed and its cache is not hidden', async () => {
  const f = fixture(); f.state.diskChanged = true; await f.run();
  assert.equal(f.calls.remove, 0); assert.equal(f.calls.render, 0); assert.equal(f.state.storyboardFilmRuntime.timelines.length, 1);
});
test('failure retains the row and releases the mutation lock for explicit retry', async () => {
  const f = fixture(); f.state.failure = true; await f.run();
  assert.equal(f.calls.remove, 0); assert.match(f.notices.at(-1).text, /删除失败/);
  assert.equal(saves.isFilmEditorSaving(f.timeline), false); f.state.failure = false; await f.run(); assert.equal(f.calls.remove, 1);
});
test('a committed old deletion cannot repaint or filter the new chat', async () => {
  const f = fixture(), gate = deferred(); f.state.commitGate = gate.promise;
  const running = f.run(); await tick(); assert.equal(f.calls.remove, 1);
  const other = { timelineId: 'film', owner: { chatKey: 'b' } }; f.state.chat = 'b'; f.state.storyboardFilmRuntime.timelines = [other];
  gate.resolve(); await running; assert.equal(f.calls.render, 0); assert.equal(f.state.storyboardFilmRuntime.timelines[0], other);
});
