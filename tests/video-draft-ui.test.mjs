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

test('the draft editor keeps prompt work local and submits only through the explicit confirmation gate', () => {
  const editor = section('async function storyboardOpenVideoDraftEditor', 'function renderStoryboardVideoDraftShelf');
  assert.match(editor, /reviseVideoDraft/);
  assert.match(editor, /await store\.save\(revised\.draft\)/);
  assert.match(editor, /referenceRecordIds: referenceIds/);
  assert.match(source, /sd-storyboard-video-readiness/);
  assert.match(source, /data-video-readiness="prompt"/);
  assert.match(editor, /evaluateVideoReadiness/);
  assert.match(editor, /promptValidation: videoPromptValidation/);
  assert.match(editor, /submissionEnabled: true/);
  assert.match(source, /sd-storyboard-video-prompt-preview/);
  assert.match(editor, /featureRuntime\.load\('videoPrompt'\)/);
  assert.match(editor, /createVideoPromptPlanFromShotSpec\(compiled\.spec\)/);
  assert.match(editor, /compileH3VideoPrompt\(plan, compiled\.spec/);
  assert.match(editor, /validateH3CompiledPrompt/);
  assert.match(source, /sd-storyboard-video-confirmation/);
  assert.match(editor, /featureRuntime\.load\('videoConfirmation'\)/);
  assert.match(editor, /createVideoGenerationConfirmation\(confirmationInput/);
  assert.match(editor, /videoConfirmationFingerprint/);
  assert.match(source, /只有点按“确认生成”才会创建并发送付费任务/);
  assert.match(editor, /review\.fingerprint !== videoConfirmationFingerprint/);
  assert.match(editor, /await coordinator\.createTask/);
  assert.match(editor, /await coordinator\.submit/);
  assert.match(editor, /costConfirmed: true/);
  assert.match(editor, /automatic: false/);
  assert.match(editor, /videoSubmissionPending/);
  assert.match(editor, /请勿重复生成/);
  assert.match(style, /\.sd-storyboard-video-confirmation\s*\{[\s\S]*position:\s*absolute/);
  assert.match(source, /sd-video-prompt-intelligent/);
  assert.match(editor, /buildVideoPromptPlanRequest\(compiled\.spec/);
  assert.match(editor, /storyboardCallCompiler\(request\.messages/);
  assert.match(editor, /parseVideoPromptPlanResponse\(raw, compiled\.spec\)/);
  assert.match(editor, /const previousPrompt = String\(videoPromptTextarea\?\.value/);
  assert.match(editor, /sequence !== videoPromptSequence/);
  assert.match(editor, /智能整理调用失败或返回结构不完整，已保留当前预览/);
  assert.match(editor, /dataset\.userEdited = 'true'/);
  assert.match(editor, /只保留在本次编辑中，不会自动提交/);
  assert.match(source, /subject_reference: '主体'/);
  assert.match(source, /style_reference: '风格'/);
  assert.match(source, /motion_reference: '动作'/);
  assert.doesNotMatch(editor, /storyboardGenerate|fetch\(|apiKey/i);
  const init = section('function init()', 'export async function onActivate');
  assert.doesNotMatch(init, /storyboardEnsureVideoDraftRuntime|featureRuntime\.load\('videoDraft/);
});

test('dynamic screening room restores drafts independently from tasks and films', () => {
  const refresh = section('async function storyboardRefreshVideoGallery', 'function storyboardVideoExtension');
  assert.match(refresh, /Promise\.allSettled\(\[mediaPromise, taskPromise, draftPromise\]\)/);
  assert.match(refresh, /video_drafts_unavailable/);
  assert.match(source, /data-storyboard-video-draft=/);
  assert.match(source, /storyboardOpenVideoDraftEditor\(draftId\)/);
  assert.match(source, /storyboardRequestVideoTaskCancellation\(taskId, button\)/);
  assert.match(source, /coordinator\.requestCancellation\(\{ taskId, chatKey \}\)/);
  assert.match(source, /继续取消/);
  assert.match(source, /item\.canReopenDraft/);
  assert.match(source, /storyboardOpenVideoDraftEditor\(draftId\)/);
  assert.match(source, /找不到这份动态草稿，可能已被清理/);
});

test('draft overlays are mobile-safe and cleaned up across runtime boundaries', () => {
  assert.match(style, /\.sd-storyboard-video-draft-layer\s*\{/);
  assert.match(style, /@media \(max-width: 640px\)[\s\S]*\.sd-storyboard-video-draft-editor/);
  assert.match(source, /function storyboardUnbindChat\([\s\S]*storyboardCloseVideoDraftEditor\(\)/);
  assert.match(source, /clean\('video gallery',[\s\S]*storyboardCloseVideoDraftEditor\(\)/);
});

test('completed motion stays a poster until an explicit inline play action', () => {
  const markup = section('function storyboardInlineRecordMarkup', 'function storyboardInlinePlaceholderMarkup');
  const player = section('async function storyboardPlayInlineVideo', 'function storyboardInlinePlaceholderMarkup');
  assert.match(markup, /storyboardInlineVideoForRecord\(record\.id\)/);
  assert.match(markup, /data-storyboard-chat-action="play-motion"/);
  assert.match(player, /storyboardVideoGallerySession\.open\(assetId, \{ chatKey \}\)/);
  assert.match(player, /playback\.sourceRecordId !== record\.id/);
  assert.match(player, /video\.controls = true/);
  assert.match(player, /video\.playsInline = true/);
  assert.match(player, /video\.preload = 'metadata'/);
  assert.doesNotMatch(player, /autoplay\s*=\s*true/);
  assert.match(source, /storyboardScheduleInlineVideoHydration\(Math\.max\(700, delay\)\)/);
  const hydration = section('function storyboardScheduleInlineVideoHydration', 'function storyboardCloseLightbox');
  assert.match(hydration, /storyboardVideoGallerySession\.list\(chatKey, \{ limit: 300 \}\)/);
  assert.match(hydration, /runtime\.buildVideoVersionChains\(mediaItems\)/);
  assert.doesNotMatch(hydration, /videoStore|videoDraftStore|listTasks|listBudget/);
});

test('frame picking remains bounded, chat-scoped and stores stable ids only', () => {
  const candidates = section('function storyboardVideoDraftCandidateRecords', 'function storyboardVideoDraftEditorMarkup');
  const editor = section('async function storyboardOpenVideoDraftEditor', 'function renderStoryboardVideoDraftShelf');
  assert.match(candidates, /storyboardRecordChatKey\(record, chatKey\) === chatKey/);
  assert.match(candidates, /slice\(0, 120\)/);
  assert.match(editor, /selected\.size >= 9/);
  assert.match(source, /sd-video-draft-subject-binding/);
  assert.match(editor, /subjectBindings: \{ \.\.\.\(storyboardVideoDraftEditor\.selection\.subjectBindings/);
  assert.match(editor, /boundId === characterId/);
  assert.match(editor, /主体参考还需绑定对应人物/);
  assert.doesNotMatch(editor, /\.url\s*=|base64|Blob|createObjectURL/i);
});
