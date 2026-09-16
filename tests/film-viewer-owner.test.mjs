import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
    const roots = [], notices = [], calls = { opened: 0, disposed: 0 };
    const timelines = ['a', 'b'].map(timelineId => ({ timelineId, owner: { chatKey: 'chat' } }));
    const player = { createVideoTimelinePlaybackSession: () => ({ open: async () => { calls.opened++; }, dispose: () => { calls.disposed++; } }) };
    const state = vm.createContext({
        storyboardFilmViewerPaintSeq: 0, storyboardFilmSubtitleTimer: null, storyboardFilmVoiceFailures: new Set(),
        storyboardFilmPlaybackSession: null, storyboardFilmPlaybackState: null, storyboardFilmViewerPostproduction: null,
        storyboardFilmViewerLastReadyIndex: -1, storyboardFilmViewerEl: null, storyboardFilmVoiceAutoplayWarned: false,
        storyboardVideoGallerySession: {}, storyboardFilmRuntime: { timelines }, blobStore: {}, currentChat: 'chat',
        getChatKey: () => state.currentChat,
        storyboardReleaseFilmVoicePlayback() {}, storyboardFilmResolveStill() {}, storyboardPaintFilmViewer() {},
        storyboardEnsureFilmRuntime: async () => ({ store: { load: async () => null } }),
        storyboardEnsureFilmPostproductionRuntime: async () => ({
            store: { load: async id => { if (state.readPost) return state.readPost(id); return { timelineId: id }; } },
            postproductionModule: { createEmptyVideoPostproduction: timeline => ({ timelineId: timeline.timelineId, empty: true }) },
        }),
        featureRuntime: { load: async name => {
            if (name === 'videoTimelinePlayer') return state.readPlayer ? state.readPlayer() : player;
            if (name === 'videoGallery') return {};
            assert.fail(`Unexpected feature ${name}`);
        } },
        appearanceSession: { mountPortal: root => { root.mounted = true; } },
        document: { createElement: () => ({ connected: false, setAttribute() {}, addEventListener() {}, focus() {}, remove() { this.connected = false; } }),
            body: { appendChild: root => { root.connected = true; roots.push(root); } } },
        toast: text => notices.push(text), clearTimeout,
    });
    vm.runInContext(['storyboardCloseFilmViewer', 'storyboardOpenFilmViewer'].map(storyboardFunctionSource).join('\n'), state);
    return { state, roots, notices, calls, player, live: () => roots.filter(root => root.connected) };
}

for (const action of ['close', 'chat-change']) {
    test(`film postproduction cannot reopen after ${action}`, async () => {
        const f = fixture(), gate = deferred(), entered = deferred();
        f.state.readPost = async () => { entered.resolve(); return gate.promise; };
        const opening = f.state.storyboardOpenFilmViewer('a'); await entered.promise;
        if (action === 'close') f.state.storyboardCloseFilmViewer(); else f.state.currentChat = 'other-chat';
        gate.resolve({ timelineId: 'a' }); await opening;
        assert.equal(f.live().length, 0); assert.equal(f.calls.opened, 0);
        assert.equal(f.state.storyboardFilmViewerPostproduction, null); assert.deepEqual(f.notices, []);
    });
}

test('old postproduction completion cannot overwrite or duplicate a newer film viewer', async () => {
    const f = fixture(), gate = deferred(), entered = deferred();
    f.state.readPost = async id => { if (id === 'a') { entered.resolve(); return gate.promise; } return { timelineId: id }; };
    const old = f.state.storyboardOpenFilmViewer('a'); await entered.promise;
    await f.state.storyboardOpenFilmViewer('b');
    const current = f.state.storyboardFilmViewerEl, session = f.state.storyboardFilmPlaybackSession;
    gate.resolve({ timelineId: 'a' }); await old;
    assert.equal(f.live().length, 1); assert.equal(f.state.storyboardFilmViewerEl, current);
    assert.equal(f.state.storyboardFilmPlaybackSession, session); assert.equal(f.state.storyboardFilmViewerPostproduction.timelineId, 'b');
    assert.equal(f.calls.opened, 1); assert.equal(f.calls.disposed, 0); assert.deepEqual(f.notices, []);
});

test('a stale feature rejection does not close the newer successful film', async () => {
    const f = fixture(), gate = deferred(), entered = deferred(); let loads = 0;
    f.state.readPlayer = async () => { if (++loads === 1) { entered.resolve(); return gate.promise; } return f.player; };
    const old = f.state.storyboardOpenFilmViewer('a'); await entered.promise;
    await f.state.storyboardOpenFilmViewer('b'); const current = f.state.storyboardFilmViewerEl;
    gate.reject(Error('late module failure')); await old;
    assert.equal(f.live().length, 1); assert.equal(f.state.storyboardFilmViewerEl, current);
    assert.equal(f.calls.disposed, 0); assert.deepEqual(f.notices, []);
});

test('an owned initialization failure still closes its own viewer and reports once', async () => {
    const f = fixture(); f.state.readPlayer = async () => ({ createVideoTimelinePlaybackSession: () => ({
        open: async () => { f.state.storyboardFilmViewerPaintSeq++; throw Error('owned player failure after paint'); },
        dispose: () => { f.calls.disposed++; },
    }) });
    await f.state.storyboardOpenFilmViewer('a');
    assert.equal(f.live().length, 0); assert.equal(f.calls.disposed, 1); assert.equal(f.notices.length, 1);
});
