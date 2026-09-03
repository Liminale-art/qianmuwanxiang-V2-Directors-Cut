import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('director voice generation is explicit, sequential and uses the existing TTS cache', () => {
  const generate = source.slice(
    source.indexOf('async function storyboardGenerateDirectorVoice'),
    source.indexOf('async function storyboardRefreshFilmGallery'),
  );
  assert.match(generate, /await storyboardDirectorWorkOrderForRecord\(record, 'voice'\)/);
  assert.match(generate, /directorWorkOrderToVoiceLines\(workOrder, chatKey/);
  assert.match(generate, /ttsProviderHasCredentials\(firstParams\.providerId, firstParams\)/);
  assert.match(generate, /for \(const line of pending\.slice\(0, available\)\)/);
  assert.match(generate, /await ttsSynthCached\(line, false, 'director'\)/);
  assert.match(generate, /cacheKeyForTts\(result\.params\.providerId, result\.params\)/);
  assert.doesNotMatch(generate, /Promise\.all\([^)]*ttsSynthCached/);
});

test('voice action appears only for eligible director dialogue and supports local preview', () => {
  const render = source.slice(
    source.indexOf('function renderStoryboardFilmPostproduction'),
    source.indexOf('function renderStoryboardFilmEditor'),
  );
  assert.match(render, /directorVoiceCount \? `<button[^`]+data-storyboard-film-director-voice/);
  assert.match(render, /data-storyboard-film-voice-preview/);
  const bindings = source.slice(source.indexOf('function bindStoryboardTabEvents'), source.indexOf('function bindActiveTabEvents'));
  assert.match(bindings, /data-storyboard-film-director-voice[\s\S]{0,180}storyboardGenerateDirectorVoice/);
  assert.match(bindings, /blobStore\.getAudio\(track\.source\.assetId\)/);
  assert.match(bindings, /await ttsPlayBlob\(hit\.blob\)/);
});

test('film save revalidates director subtitle and voice layer work orders before storage', () => {
  const save = source.slice(
    source.indexOf('async function storyboardSaveFilmEditor'),
    source.indexOf('async function storyboardDeleteFilmTimeline'),
  );
  assert.match(save, /for \(const cue of directorProject\.subtitles\) await validateDirectorLayer\(cue\.source, 'subtitle'\)/);
  assert.match(save, /for \(const track of directorProject\.audio\.dialogue\) await validateDirectorLayer\(track\.source, 'voice'\)/);
  assert.ok(save.indexOf('validateDirectorLayer(track.source') < save.indexOf('buildVideoTimeline'));
  assert.match(save, /workOrder\.workOrderId !== source\.workOrderId/);
});

test('director voice tracks follow and leave with their stable clip', () => {
  const reconcile = source.slice(
    source.indexOf('function storyboardReconcileFilmPostproduction'),
    source.indexOf('function storyboardCaptureFilmPostproduction'),
  );
  assert.match(reconcile, /project\.audio\.dialogue = project\.audio\.dialogue\.flatMap/);
  assert.match(reconcile, /track\.source\?\.kind !== 'director_voice'/);
  assert.match(reconcile, /if \(!timing\) return \[\]/);
  assert.match(reconcile, /startMs: timing\.startMs \+ relativeStartMs/);
});
