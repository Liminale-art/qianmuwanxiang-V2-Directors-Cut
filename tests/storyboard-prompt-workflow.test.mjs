import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStoryboardDefaults, normalizeStoryboardState } from '../qianmu-storyboard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const style = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

const defaults = createStoryboardDefaults();
assert.equal(defaults.contentRating, 'sfw');
assert.equal(defaults.paragraphMode, 'auto');
assert.equal(defaults.manualParagraphIndex, null);
assert.equal(defaults.promptDraft.artistString, '');
assert.equal(Object.hasOwn(defaults.promptDraft, 'manual'), false);
assert.equal(Object.hasOwn(defaults.promptDraft, 'autoInstruction'), false);
assert.equal(defaults.promptCompiler.worldMode, 'auto');
assert.ok(defaults.promptCompiler.tagRules.some((rule) => rule.name === 'think' && rule.action === 'remove'));

const normalized = normalizeStoryboardState({
  contentRating: 'nsfw',
  paragraphMode: 'manual',
  manualParagraphIndex: 4,
  promptDraft: { artistString: 'artist: user-owned' },
  artistPresets: [{ id: 'a1', name: '私有画师串', value: 'artist: user-owned' }],
  selectedArtistPresetId: 'a1',
  promptCompiler: {
    enabled: true,
    worldMode: 'selected',
    worldEntryIds: ['book::1'],
    tagRules: [{ name: 'thinking', action: 'remove' }, { name: 'scene', action: 'extract' }],
  },
});
assert.equal(normalized.contentRating, 'nsfw');
assert.equal(normalized.paragraphMode, 'manual');
assert.equal(normalized.manualParagraphIndex, 4);
assert.equal(normalized.promptDraft.artistString, 'artist: user-owned');
assert.equal(normalized.artistPresets[0].value, 'artist: user-owned');
assert.deepEqual(normalized.promptCompiler.worldEntryIds, ['book::1']);
assert.deepEqual(normalized.promptCompiler.tagRules, [
  { name: 'thinking', action: 'remove' },
  { name: 'scene', action: 'extract' },
]);
assert.equal(normalized.promptCompiler.excludedTags, 'thinking');

// Preprocessing is an implementation detail owned by the top automation card.
assert.doesNotMatch(source, /class="sd-storyboard-compiler-toggle/);
assert.doesNotMatch(source, /data-storyboard-content-rating=/);
assert.doesNotMatch(source, />纯手写</);
assert.doesNotMatch(source, />手动触发</);
assert.match(source, /<b>API 设置<\/b>/);
assert.match(source, /<span>取景整理 API<\/span>/);
assert.doesNotMatch(source, /<span>提示词预处理<\/span>/);

// The default path is an unobtrusive two-stage automatic flow; manual capture remains an escape hatch.
assert.match(source, /sd-storyboard-capsule-switch[\s\S]*自动提取生成词[\s\S]*自动生图/);
assert.doesNotMatch(source, /sd-storyboard-auto-flow/);
assert.match(source, /dataset\.storyboardChatAction = 'capture-floor'/);
assert.match(source, /button\.dataset\.storyboardChatAction === 'capture-floor'[\s\S]*storyboardChooseCaptureMode[\s\S]*storyboardCompilePrompt\(null, \{ plan, quiet: false \}\)[\s\S]*storyboardEditPrompt/);
assert.match(source, /function storyboardHandleAutomaticCapture/);

// A take preset is an ordered list; there is no one-off instruction field on the workbench.
assert.match(source, /<b>取景预设<\/b>/);
assert.doesNotMatch(source, /本次取景指令/);
assert.match(source, /\['presets', '取景预设'\]/);
assert.match(source, /function storyboardSavePromptInstructionFromForm/);
assert.match(source, /presetItems\.map\(\(item, index\) => `\$\{index \+ 1\}\. \$\{item\.name\}\\n\$\{item\.instruction\}`\)/,
  'ordered preset entries must enter the compiler exactly once');
assert.match(source, /sd-storyboard-preset-entry[\s\S]*draggable="true"[\s\S]*sd-storyboard-add-preset-entry/);
assert.match(source, /sd-storyboard-manual-generate[\s\S]*storyboardGenerate\(root, \{ automatic: false \}\)/,
  'manual prompt edits need an explicit generation exit inside the prompt card');
assert.doesNotMatch(source, /class="[^\"]*sd-storyboard-generate/,
  'the removed floating storyboard generation button must not return');

// Context controls and remove/extract rules must feed the actual compiler context.
for (const selector of [
  'sd-storyboard-context-character',
  'sd-storyboard-context-user',
  'sd-storyboard-context-world',
  'sd-storyboard-context-recent',
  'sd-storyboard-context-rule-action',
]) assert.match(source, new RegExp(selector));
assert.match(source, /function storyboardCleanWithTagRules[\s\S]*action === 'extract'[\s\S]*action === 'remove'/);
assert.match(source, /storyboardCleanWithTagRules\(item\.mes, state\)/);
assert.match(source, /storyboardCleanWithTagRules\(targetMessage\?\.mes \|\| '', state\)/);

// Artist strings remain entirely user-controlled and are appended only at image request time.
assert.match(source, /画师串完全由用户另行控制。不得建议、生成、改写/);
assert.doesNotMatch(source, /"artist_string"|"artist_suggestion"/);
assert.match(source, /const artistString = String\(state\.promptDraft\?\.artistString/);
assert.match(source, /sourceId === 'novel' \? `\$\{artistString\}, \$\{scenePrompt\}`/);
assert.match(source, /function storyboardSaveArtistPreset/);
assert.match(source, /function renderStoryboardArtistLibrary[\s\S]*sd-storyboard-artist-waterfall/);
assert.match(source, /querySelectorAll\('\.sd-storyboard-prompt, \.sd-storyboard-negative, \.sd-storyboard-artist-string/,
  'manual prompt and artist-string edits must persist without triggering either automatic stage');

// Image data is server-backed for one ST instance; the explicit package remains a migration tool.
assert.match(source, /<b>分镜数据打包<\/b><small>跨 SillyTavern 迁移，不包含 API Key<\/small>/);
assert.match(source, /function renderStoryboardLogs[\s\S]*sd-storyboard-pack-card/);
assert.match(source, /ctx\(\)\.saveSettingsDebounced\?\.\(\)/);
assert.match(source, /storyboardImages[\s\S]*saveMetadata/);

assert.match(style, /分镜第一阶段：无感自动化/);
assert.match(style, /\.sd-storyboard-capsule-switch/);
assert.match(style, /\.sd-storyboard-prompt-section/);
assert.match(style, /\.sd-storyboard-artist-waterfall/);

console.log('Storyboard prompt preprocessing workflow contract OK');
