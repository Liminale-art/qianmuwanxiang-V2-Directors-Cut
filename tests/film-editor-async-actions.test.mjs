import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';
const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const bindingStart = index.indexOf("  root.querySelectorAll('[data-storyboard-film-voice-preview]')");
const bindingEnd = index.indexOf("  root.querySelectorAll('[data-storyboard-film-clip]')", bindingStart);
assert.ok(bindingStart > 0 && bindingEnd > bindingStart);
const bindings = index.slice(bindingStart, bindingEnd);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
function fixture(kind = 'still') {
    const page = { isConnected: true }, notices = [], calls = { render: 0, play: 0, capture: 0 };
    const makeButton = dataset => ({ dataset, isConnected: true, disabled: false, addEventListener: (_, fn) => { if (dataset.storyboardFilmAddKind) add = fn; else preview = fn; } });
    let add, preview;
    const addButton = makeButton({ storyboardFilmAddKind: kind, storyboardFilmAddId: kind === 'motion' ? 'motion' : 'still' });
    const voiceButton = makeButton({ storyboardFilmVoicePreview: '0' });
    const root = { isConnected: true, querySelector: () => page,
        querySelectorAll: query => query === '[data-storyboard-film-add-kind]' ? [addButton] : query === '[data-storyboard-film-voice-preview]' ? [voiceButton] : [] };
    const draft = () => ({ owner: { chatKey: 'chat' }, selections: [{ clipId: 'original', kind: 'still', recordId: 'still', durationSeconds: 3 }],
        postproduction: { mode: 'layered', subtitles: [], audio: { dialogue: [{ source: { assetId: 'voice' } }] } } });
    const editor = draft();
    const state = vm.createContext({ root, storyboardFilmEditor: editor, currentChat: 'chat', panelOpen: true, MODAL_ID: 'modal', activeTab: 'imagegen',
        storyboardGalleryKind: 'film', route: { view: 'gallery' }, storyboardState: () => state.route,
        document: { getElementById: () => ({ classList: { contains: () => state.panelOpen } }) }, getChatKey: () => state.currentChat,
        uid: () => 'new-clip', storyboardCaptureFilmEditor: () => { calls.capture++; if (state.durationField) editor.selections[0].durationSeconds = state.durationField; },
        storyboardFilmPostproductionDraft: value => value.postproduction, storyboardReconcileFilmPostproduction() {},
        storyboardFilmStillRecords: () => [{ id: 'still', floor: 3 }],
        storyboardFilmMotionItems: () => [{ assetId: 'motion', recordId: 'still', owner: { floor: 3 }, technical: { durationSeconds: 4 } }],
        storyboardDirectorWorkOrderForRecord: async () => { if (state.readGate) await state.readGate(); return {}; },
        storyboardFilmSourceRecordForSelection: () => ({ id: 'still' }), storyboardProductionContext: () => ({ packetId: 'packet' }),
        storyboardDirectorDecisionSnapshot: () => ({ outputs: { subtitle: true }, lanes: { dialogue: ['line'] } }),
        storyboardFilmClipTimings: () => new Map([['original', { startMs: 0, endMs: 3000 }]]),
        featureRuntime: { load: async () => ({ directorWorkOrderToSubtitleCues: () => [{ cueId: 'imported', source: { refId: 'ref' }, text: '原台词' }] }) },
        blobStore: { getAudio: async () => { if (state.readGate) await state.readGate(); return { blob: {} }; } },
        ttsPlayBlob: async () => { calls.play++; }, toast: text => notices.push(text), storyboardVideoOperationIssueLabel: text => text,
        renderModal: () => { calls.render++; },
    });
    const guard = storyboardFunctionSource('storyboardFilmEditorGuard');
    vm.runInContext(guard + '\n' + storyboardFunctionSource('storyboardImportDirectorSubtitles') + '\n' + bindings, state);
    return { state, root, page, editor, draft, calls, notices, add: () => add(), preview: () => preview(),
        importSubtitles: () => state.storyboardImportDirectorSubtitles(root, voiceButton) };
}
function invalidate(f, action) {
    if (action === 'new-draft') f.state.storyboardFilmEditor = f.draft();
    if (action === 'change-chat') f.state.currentChat = 'other';
    if (action === 'close') f.state.panelOpen = false;
    if (action === 'replace-page') f.page.isConnected = false;
}
for (const action of ['new-draft', 'change-chat', 'close', 'replace-page']) {
    for (const operation of ['still', 'motion', 'preview', 'subtitles']) {
        test(`late ${operation} is ignored after ${action}`, async () => {
            const f = fixture(operation), gate = deferred(), entered = deferred();
            f.state.readGate = async () => { entered.resolve(); await gate.promise; };
            const pending = operation === 'preview' ? f.preview() : operation === 'subtitles' ? f.importSubtitles() : f.add();
            await entered.promise; invalidate(f, action); gate.resolve(); await pending;
            assert.equal(f.calls.render, 0); assert.equal(f.calls.play, 0); assert.equal(f.editor.selections.length, 1);
            assert.equal(f.editor.postproduction.subtitles.length, 0); assert.equal(f.state.storyboardFilmEditor.selections.length, 1);
            assert.deepEqual(f.notices, []);
        });
    }
}
test('two approved additions cannot exceed the 120-clip bound', async () => {
    const f = fixture(), gate = deferred(); f.editor.selections = Array.from({ length: 119 }, (_, i) => ({ clipId: `clip-${i}` }));
    f.state.readGate = () => gate.promise;
    const first = f.add(), second = f.add(); gate.resolve(); await Promise.all([first, second]);
    assert.equal(f.editor.selections.length, 120); assert.equal(f.calls.render, 1);
});
test('ordinary current addition and cached voice preview still work', async () => {
    const f = fixture(); await f.add(); await f.preview();
    assert.equal(f.editor.selections.length, 2); assert.equal(f.calls.render, 1); assert.equal(f.calls.play, 1);
});
test('subtitle import keeps existing authored lines and deduplicates references', async () => {
    const f = fixture(); f.editor.postproduction.subtitles.push({ text: '手动字幕' });
    await f.importSubtitles(); await f.importSubtitles();
    assert.equal(f.editor.postproduction.subtitles.length, 2); assert.equal(f.editor.postproduction.subtitles[0].text, '手动字幕');
});
test('subtitle import does not commit timings calculated before duration editing', async () => {
    const f = fixture(), gate = deferred(), entered = deferred(); f.state.readGate = async () => { entered.resolve(); await gate.promise; };
    const importing = f.importSubtitles(); await entered.promise; f.state.durationField = 9; gate.resolve(); await importing;
    assert.equal(f.editor.postproduction.subtitles.length, 0); assert.equal(f.editor.selections[0].durationSeconds, 9); assert.equal(f.calls.render, 0);
});

test('an already-detached action cannot capture old controls into the current draft', async () => {
    const f = fixture(); f.page.isConnected = false; f.state.durationField = 9;
    await f.importSubtitles(); await f.add(); await f.preview();
    assert.equal(f.calls.capture, 0); assert.equal(f.calls.play, 0); assert.equal(f.editor.selections[0].durationSeconds, 3);
});
