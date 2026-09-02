import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const style = await readFile(new URL('../style.css', import.meta.url), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing section: ${start}`);
  assert.ok(to > from, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('inline frames expose an isolated motion-draft action', () => {
  const markup = section('function storyboardInlineRecordMarkup', 'function storyboardInlinePlaceholderMarkup');
  const handler = section('async function storyboardOnChatClick', 'function storyboardBindChat');
  assert.match(markup, /data-storyboard-chat-action="motion"/);
  assert.match(markup, /让镜头动起来/);
  assert.match(handler, /storyboardChatAction === 'motion'[^\n]+storyboardOpenVideoDraftEditor\(record\)/);
});

test('the draft editor only revises and saves local draft contracts', () => {
  const editor = section('async function storyboardOpenVideoDraftEditor', 'function renderStoryboardVideoDraftShelf');
  assert.match(editor, /reviseVideoDraft/);
  assert.match(editor, /await store\.save\(revised\.draft\)/);
  assert.match(editor, /referenceRecordIds: referenceIds/);
  assert.match(source, /subject_reference: '主体'/);
  assert.match(source, /style_reference: '风格'/);
  assert.match(source, /motion_reference: '动作'/);
  assert.doesNotMatch(editor, /storyboardGenerate|videoCoordinator|submit|fetch\(|apiKey|quote/i);
  const init = section('function init()', 'export async function onActivate');
  assert.doesNotMatch(init, /storyboardEnsureVideoDraftRuntime|featureRuntime\.load\('videoDraft/);
});

test('dynamic screening room restores drafts independently from tasks and films', () => {
  const refresh = section('async function storyboardRefreshVideoGallery', 'function storyboardVideoExtension');
  assert.match(refresh, /Promise\.allSettled\(\[mediaPromise, taskPromise, draftPromise\]\)/);
  assert.match(refresh, /video_drafts_unavailable/);
  assert.match(source, /data-storyboard-video-draft=/);
  assert.match(source, /storyboardOpenVideoDraftEditor\(draftId\)/);
});

test('draft overlays are mobile-safe and cleaned up across runtime boundaries', () => {
  assert.match(style, /\.sd-storyboard-video-draft-layer\s*\{/);
  assert.match(style, /@media \(max-width: 640px\)[\s\S]*\.sd-storyboard-video-draft-editor/);
  assert.match(source, /function storyboardUnbindChat\([\s\S]*storyboardCloseVideoDraftEditor\(\)/);
  assert.match(source, /clean\('video gallery',[\s\S]*storyboardCloseVideoDraftEditor\(\)/);
});

test('frame picking remains bounded, chat-scoped and stores stable ids only', () => {
  const candidates = section('function storyboardVideoDraftCandidateRecords', 'function storyboardVideoDraftEditorMarkup');
  const editor = section('async function storyboardOpenVideoDraftEditor', 'function renderStoryboardVideoDraftShelf');
  assert.match(candidates, /storyboardRecordChatKey\(record, chatKey\) === chatKey/);
  assert.match(candidates, /slice\(0, 120\)/);
  assert.match(editor, /selected\.size >= 9/);
  assert.doesNotMatch(editor, /\.url\s*=|base64|Blob|createObjectURL/i);
});
