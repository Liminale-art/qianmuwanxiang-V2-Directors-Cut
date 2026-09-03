import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('film viewer loads only the active director voice asset from the local cache', () => {
  const update = source.slice(
    source.indexOf('async function storyboardUpdateFilmViewerVoice'),
    source.indexOf('function storyboardUpdateFilmViewerSubtitle'),
  );
  assert.match(update, /absoluteMs >= Number\(item\.startMs\)/);
  assert.match(update, /absoluteMs < Number\(item\.endMs\)/);
  assert.ok(update.indexOf('const track =') < update.indexOf('await blobStore.getAudio(track.source.assetId)'));
  assert.doesNotMatch(update, /listAudio|Promise\.all|fetch\(/);
});

test('director voice follows play, pause and seek drift without owning the film clock', () => {
  const sync = source.slice(
    source.indexOf('function storyboardSyncFilmVoiceAudio'),
    source.indexOf('async function storyboardUpdateFilmViewerVoice'),
  );
  assert.match(sync, /> \.35/);
  assert.match(sync, /audio\.currentTime = targetSeconds/);
  assert.match(sync, /if \(!snapshot\?\.playing\)/);
  assert.match(sync, /audio\.pause\(\)/);
  assert.match(sync, /audio\.play\(\)/);
  assert.doesNotMatch(sync, /storyboardFilmPlaybackSession\?\.pause/);
});

test('director voice respects track gain, fades and gently ducks native clip audio', () => {
  const sync = source.slice(
    source.indexOf('function storyboardSyncFilmVoiceAudio'),
    source.indexOf('async function storyboardUpdateFilmViewerVoice'),
  );
  assert.match(sync, /masterGainDb/);
  assert.match(sync, /track\.fadeInMs/);
  assert.match(sync, /track\.fadeOutMs/);
  assert.match(sync, /storyboardSetFilmNativeAudioDuck\(true\)/);
  const duck = source.slice(
    source.indexOf('function storyboardSetFilmNativeAudioDuck'),
    source.indexOf('function storyboardReleaseFilmVoicePlayback'),
  );
  assert.match(duck, /active \? \.28 : 1/);
});

test('closing or repainting the viewer stops audio and revokes its object URL', () => {
  const release = source.slice(
    source.indexOf('function storyboardReleaseFilmVoicePlayback'),
    source.indexOf('function storyboardSyncFilmVoiceAudio'),
  );
  assert.match(release, /current\.audio\.pause\(\)/);
  assert.match(release, /URL\.revokeObjectURL\(current\.url\)/);
  const close = source.slice(
    source.indexOf('function storyboardCloseFilmViewer'),
    source.indexOf('async function storyboardFilmResolveStill'),
  );
  assert.match(close, /storyboardReleaseFilmVoicePlayback\(\)/);
  const paint = source.slice(
    source.indexOf('function storyboardPaintFilmViewer'),
    source.indexOf('async function storyboardOpenFilmViewer'),
  );
  assert.match(paint, /storyboardReleaseFilmVoicePlayback\(\)/);
});
