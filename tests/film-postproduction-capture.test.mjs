import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

function fixture(layered) {
    const project = { mode: layered ? 'layered' : 'native_only', transitions: [{ fromClipId: 'a', toClipId: 'b', type: 'crossfade' }],
        subtitles: [{ cueId: 'cue', startMs: 0, endMs: 1000, text: '保留作者字幕', source: { kind: 'manual' } }], audio: { dialogue: [{ audioId: 'voice' }] } };
    const editor = { selections: [], postproduction: project };
    const state = vm.createContext({ storyboardFilmEditor: editor, storyboardEnsureFilmClipIds() {},
        storyboardFilmPostproductionDraft: () => project, storyboardFilmClipTimings: () => new Map(), storyboardFilmDurationMs: () => 6000 });
    vm.runInContext(storyboardFunctionSource('storyboardCaptureFilmPostproduction'), state);
    const root = { querySelector: selector => selector === '.sd-storyboard-film-postproduction' || (layered && selector === '.sd-storyboard-film-post-body') ? {} : null,
        querySelectorAll: () => [] };
    return { project, capture: () => state.storyboardCaptureFilmPostproduction(root) };
}

test('native-only view does not erase hidden subtitles or transitions when captured', () => {
    const f = fixture(false), before = JSON.stringify(f.project); f.capture();
    assert.equal(JSON.stringify(f.project), before);
});

test('visible layered controls can still intentionally clear all authored rows', () => {
    const f = fixture(true); f.capture();
    assert.equal(f.project.subtitles.length, 0); assert.equal(f.project.transitions.length, 0);
    assert.equal(f.project.audio.dialogue.length, 1); assert.equal(f.project.durationMs, 6000);
});
