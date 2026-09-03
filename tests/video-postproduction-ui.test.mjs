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

test('film preview reads layered subtitles on demand and renders them as text', () => {
  const open = source.slice(source.indexOf('async function storyboardOpenFilmViewer'), source.indexOf('function renderStoryboardVideoGallery'));
  assert.match(open, /storyboardEnsureFilmPostproductionRuntime\(\)/);
  assert.match(open, /postproduction\.store\.load\(timeline\.timelineId, chatKey, timeline\)/);
  const subtitles = source.slice(source.indexOf('function storyboardUpdateFilmViewerSubtitle'), source.indexOf('function storyboardFilmViewerTransition'));
  assert.match(subtitles, /video\.currentTime/);
  assert.match(subtitles, /storyboardFilmViewerTimelineOffsetMs\(snapshot\)/);
  assert.match(subtitles, /line\.className = 'sd-storyboard-film-viewer-subtitle-line'/);
  assert.match(subtitles, /line\.textContent = String\(cue\.text \|\| ''\)/);
  assert.doesNotMatch(subtitles, /innerHTML\s*=\s*cue\.text/);
  assert.match(subtitles, /setTimeout\(tick, 120\)/);
});

test('film preview applies bounded transition effects without opening a second media resource', () => {
  const paint = source.slice(source.indexOf('function storyboardFilmViewerTransition'), source.indexOf('async function storyboardOpenFilmViewer'));
  assert.match(paint, /item\.type !== 'cut'/);
  assert.match(paint, /is-transition-\$\{transition\.type\}/);
  assert.match(paint, /Math\.max\(100, Math\.min\(2000,/);
  assert.match(styles, /is-transition-crossfade[\s\S]*sd-storyboard-viewer-crossfade/);
  assert.match(styles, /is-transition-dip_black::after[\s\S]*sd-storyboard-viewer-dip-black/);
  assert.match(styles, /sd-storyboard-film-viewer-subtitles[\s\S]*pointer-events: none/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*is-transition-crossfade/);
});

test('closing film preview releases subtitle timing and postproduction state', () => {
  const close = source.slice(source.indexOf('function storyboardCloseFilmViewer'), source.indexOf('async function storyboardFilmResolveStill'));
  assert.match(close, /clearTimeout\(storyboardFilmSubtitleTimer\)/);
  assert.match(close, /storyboardFilmPlaybackSession\?\.dispose\?\.\(\)/);
  assert.match(close, /storyboardFilmViewerPostproduction = null/);
  assert.match(close, /storyboardFilmViewerLastReadyIndex = -1/);
});
