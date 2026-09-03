import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('film imports director subtitles only through an explicit subtitle work order', () => {
  const importer = source.slice(
    source.indexOf('async function storyboardImportDirectorSubtitles'),
    source.indexOf('async function storyboardRefreshFilmGallery'),
  );
  assert.match(importer, /featureRuntime\.load\('directorWorkOrders'\)/);
  assert.match(importer, /await storyboardDirectorWorkOrderForRecord\(record, 'subtitle'\)/);
  assert.match(importer, /directorWorkOrderToSubtitleCues\(workOrder, chatKey/);
  assert.match(importer, /existingRefs\.has\(cue\.source\.refId\)/);
  assert.doesNotMatch(importer, /generateRaw|sendGenerationRequest|storyboardGenerate\(|fetch\(/);
});

test('director subtitle import stays user-triggered and unavailable without eligible clips', () => {
  const render = source.slice(
    source.indexOf('function renderStoryboardFilmPostproduction'),
    source.indexOf('function renderStoryboardFilmEditor'),
  );
  assert.match(render, /directorSubtitleCount \? `<button[^`]+data-storyboard-film-director-subtitles/);
  const bindings = source.slice(source.indexOf('function bindStoryboardTabEvents'), source.indexOf('function bindActiveTabEvents'));
  assert.match(bindings, /data-storyboard-film-director-subtitles[^\n]+addEventListener\('click'/);
  const init = source.slice(source.indexOf('function init()'), source.indexOf('function cleanupRuntime'));
  assert.doesNotMatch(init, /storyboardImportDirectorSubtitles/);
});

test('director subtitle timing follows its stable clip after reordering', () => {
  const reconcile = source.slice(
    source.indexOf('function storyboardReconcileFilmPostproduction'),
    source.indexOf('function storyboardCaptureFilmPostproduction'),
  );
  assert.match(reconcile, /storyboardFilmClipTimings\(editor\.selections\)/);
  assert.match(reconcile, /cue\.source\?\.kind !== 'director'/);
  assert.match(reconcile, /relativeStartMs = Math\.min\(durationMs - 100/);
  assert.match(reconcile, /startMs: timing\.startMs \+ relativeStartMs/);
  assert.match(reconcile, /if \(!timing\) return \[\]/);
});
