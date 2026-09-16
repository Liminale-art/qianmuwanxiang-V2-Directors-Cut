import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
    const notices = [], calls = { rendered: 0, post: 0 }, page = { isConnected: true };
    const root = { classList: { contains: () => root.open }, open: true, querySelector: () => page };
    const timelines = ['a', 'b', 'foreign'].map(timelineId => ({ timelineId, owner: { chatKey: timelineId === 'foreign' ? 'elsewhere' : 'chat' } }));
    const state = vm.createContext({
        storyboardFilmEditor: null, storyboardFilmEditorOpenSeq: 0, currentChat: 'chat', MODAL_ID: 'modal', activeTab: 'imagegen',
        storyboardGalleryKind: 'film', route: { view: 'gallery' }, storyboardState: () => state.route,
        storyboardFilmRuntime: { timelines }, getChatKey: () => state.currentChat,
        document: { getElementById: () => root },
        storyboardEnsureFilmRuntime: async () => { if (state.readRuntime) await state.readRuntime(); return { store: { load: async id => state.readTimeline?.(id) || null } }; },
        storyboardEnsureFilmPostproductionRuntime: async () => ({
            store: { load: async id => { calls.post++; return state.readPost ? state.readPost(id) : { timelineId: id }; } },
            postproductionModule: { createEmptyVideoPostproduction: timeline => ({ timelineId: timeline.timelineId, empty: true }) },
        }),
        storyboardFilmEditorFromTimeline: (timeline, postproduction) => ({ timelineId: timeline?.timelineId || 'new', owner: timeline?.owner || { chatKey: state.currentChat }, postproduction }),
        storyboardReconcileFilmPostproduction() {}, renderModal: () => { calls.rendered++; }, toast: text => notices.push(text),
    });
    vm.runInContext(storyboardFunctionSource('storyboardOpenFilmEditor'), state);
    return { state, page, root, notices, calls };
}

for (const action of ['change-chat', 'close-panel', 'leave-page', 'change-view']) {
    test(`late film editor load is discarded after ${action}`, async () => {
        const f = fixture(), gate = deferred(), entered = deferred();
        f.state.readPost = async () => { entered.resolve(); return gate.promise; };
        const opening = f.state.storyboardOpenFilmEditor('a'); await entered.promise;
        if (action === 'change-chat') f.state.currentChat = 'other';
        if (action === 'close-panel') f.root.open = false;
        if (action === 'leave-page') f.page.isConnected = false;
        if (action === 'change-view') f.state.route.view = 'create';
        gate.resolve({ timelineId: 'a' }); await opening;
        assert.equal(f.state.storyboardFilmEditor, null); assert.equal(f.calls.rendered, 0); assert.deepEqual(f.notices, []);
    });
}

test('latest requested editor wins even when an older sidecar completes later', async () => {
    const f = fixture(), gate = deferred(), entered = deferred();
    f.state.readPost = async id => { if (id === 'a') { entered.resolve(); return gate.promise; } return { timelineId: id }; };
    const old = f.state.storyboardOpenFilmEditor('a'); await entered.promise;
    await f.state.storyboardOpenFilmEditor('b'); const editor = f.state.storyboardFilmEditor;
    gate.resolve({ timelineId: 'a' }); await old;
    assert.equal(f.state.storyboardFilmEditor, editor); assert.equal(editor.timelineId, 'b'); assert.equal(f.calls.rendered, 1);
});

test('new editor creation cannot cross a chat switch during lazy loading', async () => {
    const f = fixture(), gate = deferred(); f.state.readRuntime = () => gate.promise;
    const opening = f.state.storyboardOpenFilmEditor(); f.state.currentChat = 'other'; gate.resolve(); await opening;
    assert.equal(f.state.storyboardFilmEditor, null); assert.equal(f.calls.rendered, 0); assert.deepEqual(f.notices, []);
});

test('cached timeline from another chat is not used for editor opening', async () => {
    const f = fixture(); await f.state.storyboardOpenFilmEditor('foreign');
    assert.equal(f.state.storyboardFilmEditor, null); assert.equal(f.calls.post, 0); assert.equal(f.notices.length, 1);
});

test('a stale missing timeline produces no toast in the next chat', async () => {
    const f = fixture(), gate = deferred(), entered = deferred();
    f.state.readTimeline = async () => { entered.resolve(); return gate.promise; };
    const opening = f.state.storyboardOpenFilmEditor('missing'); await entered.promise;
    f.state.currentChat = 'other'; gate.resolve(null); await opening;
    assert.equal(f.state.storyboardFilmEditor, null); assert.deepEqual(f.notices, []);
});

test('late rejection does not report an error over the current successful editor', async () => {
    const f = fixture(), gate = deferred(), entered = deferred();
    f.state.readPost = async id => { if (id === 'a') { entered.resolve(); return gate.promise; } return { timelineId: id }; };
    const old = f.state.storyboardOpenFilmEditor('a'); await entered.promise;
    await f.state.storyboardOpenFilmEditor('b'); gate.reject(Error('late read failure')); await old;
    assert.equal(f.state.storyboardFilmEditor.timelineId, 'b'); assert.equal(f.calls.rendered, 1); assert.deepEqual(f.notices, []);
});

test('current read failure remains visible without replacing the existing draft', async () => {
    const f = fixture(), editor = { timelineId: 'existing' }; f.state.storyboardFilmEditor = editor;
    f.state.readPost = async () => { throw Error('current read failure'); };
    await f.state.storyboardOpenFilmEditor('a');
    assert.equal(f.state.storyboardFilmEditor, editor); assert.equal(f.notices.length, 1); assert.equal(f.calls.rendered, 0);
});

test('successful new editor gets an empty sidecar for the current chat', async () => {
    const f = fixture(); await f.state.storyboardOpenFilmEditor();
    assert.equal(f.state.storyboardFilmEditor.timelineId, 'new'); assert.equal(f.state.storyboardFilmEditor.owner.chatKey, 'chat');
    assert.equal(f.state.storyboardFilmEditor.postproduction.empty, true); assert.equal(f.calls.rendered, 1); assert.deepEqual(f.notices, []);
});
