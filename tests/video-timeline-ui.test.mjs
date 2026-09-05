import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

test('the screening room exposes film as a distinct product route', () => {
  assert.match(source, /data-storyboard-gallery-kind="stills"/);
  assert.match(source, /data-storyboard-gallery-kind="motion"/);
  assert.match(source, /data-storyboard-gallery-kind="film"/);
  assert.match(source, /if \(storyboardGalleryKind === 'film'\) return renderStoryboardFilmGallery\(\)/);
  assert.match(source, /gallery: 'SCREENING ROOM'/, 'gallery heading belongs to the shared page title');
  assert.match(source, /sd-storyboard-gallery-page sd-storyboard-film-page/, 'film keeps its distinct content route');
  assert.match(source, /新建影片/);
});

test('film entry loads only lightweight timeline and media indexes on demand', () => {
  const start = source.indexOf('async function storyboardRefreshFilmGallery');
  const end = source.indexOf('async function storyboardOpenFilmEditor', start);
  const block = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(block, /featureRuntime\.load\('videoGallery'\)/);
  assert.match(block, /store\.list\(chatKey, \{ limit: 200 \}\)/);
  assert.match(block, /storyboardVideoGallerySession\.list\(chatKey, \{ limit: 300 \}\)/);
  assert.doesNotMatch(block, /\.open\(|getVideoMedia|createObjectURL|<video|\.drive\(|\.submit\(|setInterval/);
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('export async function onActivate'));
  assert.doesNotMatch(initSource, /storyboardRefreshFilmGallery|featureRuntime\.load\('videoTimelineStore'\)/);
});

test('the editor keeps exact ordered sources and saves through the strict contract', () => {
  assert.match(source, /function renderStoryboardFilmEditor\(current\)/);
  assert.match(source, /data-storyboard-film-add-kind="motion"/);
  assert.match(source, /data-storyboard-film-add-kind="still"/);
  assert.match(source, /data-storyboard-film-move="-1"[\s\S]*data-storyboard-film-move="1"/);
  assert.match(source, /data-storyboard-film-duration/);
  assert.match(source, /data-storyboard-film-audio/);
  const saveStart = source.indexOf('async function storyboardSaveFilmEditor');
  const saveEnd = source.indexOf('async function storyboardDeleteFilmTimeline', saveStart);
  const saveBlock = source.slice(saveStart, saveEnd);
  assert.match(saveBlock, /timelineModule\.buildVideoTimeline\(\{/);
  assert.match(saveBlock, /motionItems: storyboardFilmMotionItems\(\)/);
  assert.match(saveBlock, /stillRecords: storyboardFilmStillRecords\(chatKey\)/);
  assert.match(saveBlock, /selections: storyboardFilmEditor\.selections/);
  assert.match(saveBlock, /store\.save\(\{ \.\.\.built\.timeline, createdAt: storyboardFilmEditor\.createdAt \}\)/);
  assert.doesNotMatch(saveBlock, /prompt|apiKey|Blob|base64|fetch\(/i);
});

test('film deletion removes only the timeline and never its source media', () => {
  const start = source.indexOf('async function storyboardDeleteFilmTimeline');
  const end = source.indexOf('function renderStoryboardVideoGallery', start);
  const block = source.slice(start, end);
  assert.match(block, /store\.remove\(\[timelineId\]\)/);
  assert.match(block, /不会删除静帧和动态成片/);
  assert.doesNotMatch(block, /deleteVideoMedia|storyboardDeleteRecord|removeFavorite/);
});

test('saved films expose an explicit on-demand sequential preview', () => {
  assert.match(source, /class="sd-icon-btn sd-storyboard-film-preview"/);
  const start = source.indexOf('async function storyboardOpenFilmViewer');
  const end = source.indexOf('function renderStoryboardVideoGallery', start);
  const block = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(block, /featureRuntime\.load\('videoTimelinePlayer'\)/);
  assert.match(block, /createVideoTimelinePlaybackSession\(\{/);
  assert.match(block, /openMotion: \(assetId, options\) => storyboardVideoGallerySession\.open\(assetId, options\)/);
  assert.match(block, /await storyboardFilmPlaybackSession\.open\(timeline, \{ chatKey \}\)/);
  assert.match(block, /openRequest !== storyboardFilmViewerPaintSeq/);
  const paintStart = source.indexOf('function storyboardPaintFilmViewer');
  const paintBlock = source.slice(paintStart, start);
  assert.match(paintBlock, /<video src="\$\{htmlEscape\(frame\.url\)\}" playsinline preload="metadata"/);
  assert.match(paintBlock, /storyboardFilmPlaybackSession\?\.ended\?\.\(\)/);
  assert.doesNotMatch(block, /fetch\(|Worker|ffmpeg|transcod/i);
});

test('film playback resources are disposed at every ownership boundary', () => {
  assert.match(source, /function storyboardCloseFilmViewer\(\) \{[\s\S]*storyboardFilmPlaybackSession\?\.dispose\?\.\(\)/);
  const chatChange = source.slice(source.indexOf('async function storyboardHandleChatChanged'), source.indexOf('async function storyboardPrepareGatewayAssets'));
  assert.match(chatChange, /storyboardCloseFilmViewer\(\)/);
  const closeModal = source.slice(source.indexOf('function closeModal()'), source.indexOf('function openTextEditor'));
  assert.match(closeModal, /storyboardCloseFilmViewer\(\)/);
  const cleanup = source.slice(source.indexOf('function cleanupRuntime'));
  assert.match(cleanup, /storyboardCloseFilmViewer\(\)/);
});

test('chat changes invalidate the volatile editor before another chat can render it', () => {
  const start = source.indexOf('async function storyboardHandleChatChanged');
  const end = source.indexOf('async function storyboardPrepareGatewayAssets', start);
  const block = source.slice(start, end);
  assert.match(block, /storyboardFilmEditor = null/);
  assert.match(block, /storyboardFilmRuntime[\s\S]*requestId: storyboardFilmRuntime\.requestId \+ 1/);
});

test('film workspace is bounded and collapses to one column on narrow screens', () => {
  assert.match(css, /\.sd-storyboard-gallery-kind-switch\s*\{[\s\S]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.sd-storyboard-film-workspace\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1\.08fr\) minmax\(250px, \.92fr\)/);
  assert.match(css, /\.sd-storyboard-film-source-grid\s*\{[\s\S]*max-height:\s*260px;[\s\S]*overflow:\s*auto/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.sd-storyboard-film-workspace\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /\.sd-storyboard-film-viewer\s*\{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.sd-storyboard-film-viewer\s*\{[\s\S]*grid-template-columns:\s*1fr/);
});
