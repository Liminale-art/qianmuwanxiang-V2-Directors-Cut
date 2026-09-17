import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import * as timelineModule from '../qianmu-video-timeline.js';
import * as postproductionModule from '../qianmu-video-postproduction.js';
import { isFilmEditorSaving, saveFilmEditorSnapshot } from '../qianmu-film-editor-save.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
    const notices = [], writes = [], posts = [], root = { isConnected: true }, button = { disabled: false, isConnected: true };
    const draft = title => ({ timelineId: 'film-' + title, title, owner: { chatKey: 'chat' }, createdAt: 1,
        selections: [{ clipId: 'clip-a', kind: 'still', recordId: 'still', durationSeconds: 3, audio: 'mute' }],
        postproduction: { mode: 'native_only', transitions: [], subtitles: [], audio: { dialogue: [], ambience: [], music: [] } } });
    const editor = draft('original');
    const state = vm.createContext({
        storyboardFilmEditor: editor, currentChat: 'chat', field: 'original', panelOpen: true, MODAL_ID: 'modal', renders: 0,
        document: { getElementById: () => ({ classList: { contains: () => state.panelOpen } }) },
        getChatKey: () => state.currentChat, clone: structuredClone,
        isFilmEditorSaving, saveFilmEditorSnapshot,
        storyboardFilmRuntime: { timelines: [] }, storyboardFilmPostproductionDraft: value => value.postproduction,
        storyboardCaptureFilmEditor: () => { if (state.storyboardFilmEditor) state.storyboardFilmEditor.title = state.field; },
        storyboardFilmStillRecords: () => [{ id: 'still', chatKey: 'chat', floor: 3 }], storyboardFilmMotionItems: () => [],
        storyboardDirectorWorkOrderForRecord: async (...args) => state.approval ? state.approval(...args) : null,
        storyboardEnsureFilmRuntime: async () => ({ timelineModule, store: { save: async value => {
            if (state.writeFailure) throw Error('test timeline failure'); writes.push(structuredClone(value)); if (state.writeGate) await state.writeGate; return { ...value, updatedAt: 4 };
        } } }),
        storyboardEnsureFilmPostproductionRuntime: async () => ({ postproductionModule, store: { save: async (value, timeline) => {
            if (state.postFailure) throw Error('test sidecar failure'); posts.push(structuredClone(value)); return postproductionModule.normalizeVideoPostproduction(value, timeline);
        } } }),
        toast: (text, tone) => notices.push({ text, tone }), storyboardVideoOperationIssueLabel: text => text,
        renderModal: () => { state.renders++; },
    });
    vm.runInContext(storyboardFunctionSource('storyboardSaveFilmEditor'), state);
    return { state, root, button, editor, draft, notices, writes, posts, save: () => state.storyboardSaveFilmEditor(root, button) };
}

for (const action of ['replace-editor', 'change-chat', 'close-panel', 'edit-text']) {
    test(`film save does not start persistence after ${action} during approval`, async () => {
        const f = fixture(), gate = deferred(), entered = deferred();
        f.state.approval = async () => { entered.resolve(); await gate.promise; };
        const saving = f.save(); await entered.promise;
        if (action === 'replace-editor') { f.state.storyboardFilmEditor = f.draft('new'); f.state.field = 'new'; }
        if (action === 'change-chat') f.state.currentChat = 'other';
        if (action === 'close-panel') f.state.panelOpen = false;
        if (action === 'edit-text') f.state.field = 'new text';
        gate.resolve(); await saving;
        assert.equal(f.writes.length, 0); assert.equal(f.posts.length, 0); assert.equal(f.button.disabled, false);
        assert.ok(f.state.storyboardFilmEditor); assert.equal(f.state.renders, 0);
    });
}

test('completion of an already-started save keeps subsequent uncommitted text', async () => {
    const f = fixture(), gate = deferred(); f.state.writeGate = gate.promise;
    const saving = f.save(); while (!f.writes.length) await new Promise(resolve => setImmediate(resolve));
    f.state.field = 'later edit'; gate.resolve(); await saving;
    assert.equal(f.writes[0].title, 'original'); assert.equal(f.posts.length, 1);
    assert.equal(f.state.storyboardFilmEditor, f.editor); assert.equal(f.editor.title, 'later edit');
    assert.equal(f.state.renders, 0); assert.equal(f.button.disabled, false);
});

test('an older completed save cannot close a newer editor', async () => {
    const f = fixture(), gate = deferred(); f.state.writeGate = gate.promise;
    const saving = f.save(); while (!f.writes.length) await new Promise(resolve => setImmediate(resolve));
    const newer = f.draft('newer'); f.state.storyboardFilmEditor = newer; f.state.field = 'newer';
    gate.resolve(); await saving;
    assert.equal(f.state.storyboardFilmEditor, newer); assert.equal(f.posts.length, 1); assert.equal(f.state.renders, 0);
    assert.deepEqual(f.notices, []);
});

test('repeat save calls for the same editor do not run overlapping writes', async () => {
    const f = fixture(), gate = deferred(); f.state.writeGate = gate.promise;
    const first = f.save(); while (!f.writes.length) await new Promise(resolve => setImmediate(resolve));
    const second = f.save(); await new Promise(resolve => setImmediate(resolve)); gate.resolve(); await Promise.all([first, second]);
    assert.equal(f.writes.length, 1); assert.equal(f.posts.length, 1);
});

test('a sidecar failure reports partial persistence and leaves the draft retryable', async () => {
    const f = fixture(); f.state.postFailure = true; await f.save();
    assert.equal(f.writes.length, 1); assert.equal(f.posts.length, 0); assert.equal(f.state.storyboardFilmEditor, f.editor);
    assert.equal(f.button.disabled, false); assert.ok(f.notices.some(item => item.text.includes('后期') && item.text.includes('已保存')));
});

test('successful unchanged save persists both snapshots and returns to the list', async () => {
    const f = fixture(); await f.save();
    assert.equal(f.writes.length, 1); assert.equal(f.posts.length, 1); assert.equal(f.state.storyboardFilmEditor, null);
    assert.equal(f.state.renders, 1); assert.equal(f.state.storyboardFilmRuntime.timelines[0].title, 'original');
});

test('sources disappearing during approval are rechecked before the first write', async () => {
    const f = fixture(); f.state.approval = async () => { f.state.storyboardFilmStillRecords = () => []; };
    await f.save(); assert.equal(f.writes.length, 0); assert.equal(f.posts.length, 0);
    assert.ok(f.notices.some(item => item.text.includes('素材已不可用')));
});

test('invalid authored subtitles are rejected before any timeline persistence', async () => {
    const f = fixture(); f.editor.postproduction.mode = 'layered';
    f.editor.postproduction.subtitles = [{ cueId: 'empty', startMs: 0, endMs: 1000, text: '', kind: 'dialogue' }];
    await f.save(); assert.equal(f.writes.length, 0); assert.equal(f.posts.length, 0);
    assert.ok(f.notices.some(item => item.text.includes('字幕正文')));
});

test('director source approval failure cannot fall through to writes', async () => {
    const f = fixture(); f.state.approval = async () => { throw Error('director_source_invalid'); };
    await f.save(); assert.equal(f.writes.length, 0); assert.equal(f.posts.length, 0); assert.equal(f.button.disabled, false);
});

test('director sidecar approval is separately matched, not inherited from a film source', async () => {
    const f = fixture(), consumers = []; f.editor.postproduction.mode = 'layered';
    f.editor.postproduction.subtitles = [{ cueId: 'director-cue', startMs: 0, endMs: 1000, text: '原台词', kind: 'dialogue',
        source: { kind: 'director', recordId: 'still', workOrderId: 'approved', decisionId: 'expected' } }];
    f.state.approval = async (_, consumer) => { consumers.push(consumer); return { workOrderId: 'approved', source: { decisionId: 'different' } }; };
    await f.save(); assert.deepEqual(consumers, ['film', 'subtitle']); assert.equal(f.writes.length, 0); assert.equal(f.posts.length, 0);
});

test('partial save remains retryable without changing the stable timeline id', async () => {
    const f = fixture(); f.state.postFailure = true; await f.save(); f.state.postFailure = false; await f.save();
    assert.equal(f.writes.length, 2); assert.equal(f.posts.length, 1); assert.equal(f.writes[0].timelineId, f.writes[1].timelineId);
    assert.equal(f.state.storyboardFilmEditor, null);
});

test('failed first write reports failure, unlocks and can be retried', async () => {
    const f = fixture(); f.state.writeFailure = true; await f.save();
    assert.equal(f.posts.length, 0); assert.equal(f.button.disabled, false); assert.equal(f.state.storyboardFilmEditor, f.editor);
    f.state.writeFailure = false; await f.save(); assert.equal(f.writes.length, 1); assert.equal(f.posts.length, 1);
});

test('chat changes after write starts finish only its captured pair without updating the new chat', async () => {
    const f = fixture(), gate = deferred(); f.state.writeGate = gate.promise;
    const saving = f.save(); while (!f.writes.length) await new Promise(resolve => setImmediate(resolve));
    f.state.currentChat = 'other'; gate.resolve(); await saving;
    assert.equal(f.posts.length, 1); assert.equal(f.posts[0].owner.chatKey, 'chat');
    assert.equal(f.state.storyboardFilmRuntime.timelines.length, 0); assert.equal(f.state.renders, 0); assert.deepEqual(f.notices, []);
});

test('reopening the same timeline cannot start a concurrent write from another editor object', async () => {
    const f = fixture(), gate = deferred(); f.state.writeGate = gate.promise;
    const first = f.save(); while (!f.writes.length) await new Promise(resolve => setImmediate(resolve));
    const newer = f.draft('new'); newer.timelineId = f.editor.timelineId; f.state.storyboardFilmEditor = newer; f.state.field = 'new';
    await f.save(); assert.equal(f.writes.length, 1); assert.equal(f.posts.length, 0);
    gate.resolve(); await first; assert.equal(f.state.storyboardFilmEditor, newer);
    await f.save(); assert.equal(f.writes.length, 2); assert.equal(f.posts.length, 2); assert.equal(f.state.storyboardFilmEditor, null);
});

test('a partial write remains explicitly reported if its editor has already been replaced', async () => {
    const f = fixture(), gate = deferred(); f.state.writeGate = gate.promise; f.state.postFailure = true;
    const saving = f.save(); while (!f.writes.length) await new Promise(resolve => setImmediate(resolve));
    const newer = f.draft('new'); f.state.storyboardFilmEditor = newer; gate.resolve(); await saving;
    assert.equal(f.state.storyboardFilmEditor, newer); assert.equal(f.state.renders, 0);
    assert.ok(f.notices.some(item => item.text.includes('原影片顺序已保存') && item.text.includes('后期设置保存失败')));
});
