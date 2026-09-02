import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

test('the screening room separates stills and motion without changing the main storyboard route', () => {
  assert.match(source, /data-storyboard-gallery-kind="stills"/);
  assert.match(source, /data-storyboard-gallery-kind="motion"/);
  assert.match(source, /function renderStoryboardGallery\(state\) \{\s*if \(storyboardGalleryKind === 'motion'\) return renderStoryboardVideoGallery\(\)/);
  assert.match(source, /\['gallery', '阅片室'/);
});

test('the motion list stays metadata-only and loads media only after a card is opened', () => {
  const renderStart = source.indexOf('function renderStoryboardVideoGallery()');
  const refreshStart = source.indexOf('async function storyboardRefreshVideoGallery', renderStart);
  const renderBlock = source.slice(renderStart, refreshStart);
  assert.ok(renderStart > 0 && refreshStart > renderStart);
  assert.doesNotMatch(renderBlock, /<video|\.open\(|getVideoMedia|createObjectURL/);
  assert.match(source, /async function storyboardOpenVideoViewer\(assetId\)[\s\S]*storyboardVideoGallerySession\.open\(assetId, \{ chatKey \}\)/);
  assert.match(source, /<video src="\$\{htmlEscape\(playback\.url\)\}" controls autoplay playsinline preload="metadata">/);
});

test('motion storage is loaded only in the selected gallery view and never at startup', () => {
  assert.match(source, /state\.view === 'gallery' && storyboardGalleryKind === 'motion'[\s\S]*storyboardRefreshVideoGallery/);
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('export async function onActivate'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoGallery'\)|storyboardRefreshVideoGallery/);
  assert.match(source, /featureRuntime\.load\('videoGallery'\)/);
  assert.match(source, /featureRuntime\.load\('videoStore'\)/);
  assert.match(source, /storyboardVideoTaskStore\.listTasks\(chatKey, \{ limit: 200 \}\)/);
});

test('task status is read from local storage without polling or submission', () => {
  const refreshStart = source.indexOf('async function storyboardRefreshVideoGallery');
  const openStart = source.indexOf('async function storyboardOpenVideoViewer', refreshStart);
  const refreshBlock = source.slice(refreshStart, openStart);
  assert.match(source, /function renderStoryboardVideoTaskShelf\(tasks = \[\], warning = ''\)/);
  assert.match(source, /待核对提交|动态任务/);
  assert.doesNotMatch(refreshBlock, /\.drive\(|\.submit\(|resumePlans|pollMiniMax|setInterval|setTimeout/);
  assert.match(refreshBlock, /Promise\.allSettled\(\[mediaPromise, taskPromise\]\)/);
});

test('playback URLs are released on close, chat switch, modal close and extension cleanup', () => {
  assert.match(source, /function storyboardCloseVideoViewer\(\) \{\s*storyboardVideoPlayback\?\.release\?\.\(\)/);
  const chatChange = source.slice(source.indexOf('async function storyboardHandleChatChanged'), source.indexOf('async function storyboardPrepareGatewayAssets'));
  assert.match(chatChange, /storyboardCloseVideoViewer\(\)/);
  const closeModal = source.slice(source.indexOf('function closeModal()'), source.indexOf('function openTextEditor'));
  assert.match(closeModal, /storyboardCloseVideoViewer\(\)/);
  const cleanup = source.slice(source.indexOf('function cleanupRuntime'));
  assert.match(cleanup, /storyboardVideoGallerySession\?\.dispose\?\.\(\)/);
});

test('motion cards and the player have a bounded mobile layout', () => {
  assert.match(css, /\.sd-storyboard-video-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(auto-fill, minmax\(205px, 1fr\)\)/);
  assert.match(css, /\.sd-storyboard-video-viewer\s*\{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.sd-storyboard-video-viewer\s*\{[\s\S]*grid-template-columns:\s*1fr/);
});
