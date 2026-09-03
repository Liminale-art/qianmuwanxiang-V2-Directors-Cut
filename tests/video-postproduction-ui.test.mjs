import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');

test('film editor exposes bounded native and layered postproduction controls', () => {
  const render = source.slice(source.indexOf('function renderStoryboardFilmPostproduction'), source.indexOf('function renderStoryboardFilmEditor'));
  assert.match(render, /data-storyboard-film-post-mode="native_only"/);
  assert.match(render, /data-storyboard-film-post-mode="layered"/);
  assert.match(render, /value="cut"[\s\S]*value="crossfade"[\s\S]*value="dip_black"/);
  assert.match(render, /value="dialogue"[\s\S]*value="narration"[\s\S]*value="caption"/);
  assert.match(render, /maxlength="1200"/);
  assert.match(styles, /sd-storyboard-film-post-body[\s\S]*grid-template-columns/);
  assert.match(styles, /sd-storyboard-film-subtitle[\s\S]*minmax\(120px, 1fr\)/);
});

test('postproduction is loaded only after opening a film editor and saved beside its timeline', () => {
  const ensure = source.slice(source.indexOf('async function storyboardEnsureFilmPostproductionRuntime'), source.indexOf('async function storyboardRefreshFilmGallery'));
  assert.match(ensure, /featureRuntime\.load\('videoPostproduction'\)/);
  assert.match(ensure, /featureRuntime\.load\('videoPostproductionStore'\)/);
  const open = source.slice(source.indexOf('async function storyboardOpenFilmEditor'), source.indexOf('async function storyboardSaveFilmEditor'));
  assert.match(open, /postproduction\.store\.load\(timeline\.timelineId, chatKey, timeline\)/);
  assert.match(open, /createEmptyVideoPostproduction/);
  const save = source.slice(source.indexOf('async function storyboardSaveFilmEditor'), source.indexOf('async function storyboardDeleteFilmTimeline'));
  assert.match(save, /validateVideoPostproduction\(postproductionCandidate, built\.timeline\)[\s\S]*if \(!postproductionValidation\.ok\)/);
  assert.ok(save.indexOf('validateVideoPostproduction(postproductionCandidate, built.timeline)') < save.indexOf('await store.save'), '后期合同必须在时间线首次写入前通过');
  assert.match(save, /postproduction\.store\.save\([\s\S]*timelineId: saved\.timelineId[\s\S]*}, saved\)/);
  const init = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(init, /storyboardEnsureFilmPostproductionRuntime|featureRuntime\.load\('videoPostproduction/);
});

test('film mutations keep stable clip ids and remove stale transition boundaries', () => {
  assert.match(source, /function storyboardEnsureFilmClipIds[\s\S]*selection\.clipId = clipId/);
  assert.match(source, /function storyboardReconcileFilmPostproduction[\s\S]*project\.transitions = project\.transitions\.filter/);
  const bindings = source.slice(source.indexOf("root.querySelectorAll('[data-storyboard-film-add-kind]')"), source.indexOf("root.querySelectorAll('.sd-storyboard-video-refresh')"));
  assert.match(bindings, /clipId: uid\('clip'\)/);
  assert.match(bindings, /storyboardReconcileFilmPostproduction\(storyboardFilmEditor\)/);
});

test('deleting a film removes only the timeline sidecar and leaves source media untouched', () => {
  const remove = source.slice(source.indexOf('async function storyboardDeleteFilmTimeline'), source.indexOf('function storyboardCloseFilmViewer'));
  assert.match(remove, /await store\.remove\(\[timelineId\]\)/);
  assert.match(remove, /postproduction\.store\.remove\(\[timelineId\]\)/);
  assert.doesNotMatch(remove, /deleteVideoMedia|deleteStoryboard|removeVideo/);
});
