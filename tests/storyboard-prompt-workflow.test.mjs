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

// A single visible robot control owns prompt preprocessing; content boundaries come from presets/context.
assert.match(source, /class="sd-storyboard-compiler-toggle/);
assert.doesNotMatch(source, /data-storyboard-content-rating=/);
assert.doesNotMatch(source, />纯手写</);
assert.doesNotMatch(source, />手动触发</);
assert.match(source, /<b>API 设置<\/b>/);
assert.match(source, /<span>提示词预处理<\/span>/);

// The default path is one unobtrusive automatic flow; manual capture remains an escape hatch.
assert.match(source, /sd-storyboard-auto-flow[\s\S]*dataset\.storyboardChatAction = 'capture-floor'/);
assert.match(source, /无感自动配图[\s\S]*新回复后自动取景并生成/);
assert.doesNotMatch(source, /sd-storyboard-toggle-pills/);
assert.match(source, /dataset\.storyboardChatAction = 'capture-floor'/);
assert.match(source, /button\.dataset\.storyboardChatAction === 'capture-floor'[\s\S]*storyboardCompilePrompt\(null, \{ plan, quiet: false \}\)/);
assert.match(source, /function storyboardHandleAutomaticCapture/);

// The LLM instruction layer is separate from image-model prompt/style presets.
assert.match(source, /<span>取景指令<\/span>/);
assert.match(source, /本次取景指令/);
assert.match(source, /给提示词预处理模型的指导；不会直接发送给生图模型/);
assert.match(source, /\['presets', '取景指令'\]/);
assert.match(source, /function storyboardSavePromptInstructionFromForm/);
assert.match(source, /const extra = String\(state\.promptDraft\.autoInstruction \|\| preset\?\.instruction \|\| ''\)/,
  'selected instructions must enter the compiler exactly once');

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

// Image data is server-backed for one ST instance; the explicit package remains a migration tool.
assert.match(source, /<b>分镜数据打包<\/b><small>跨 SillyTavern 迁移，不包含 API Key<\/small>/);
assert.match(source, /ctx\(\)\.saveSettingsDebounced\?\.\(\)/);
assert.match(source, /storyboardImages[\s\S]*saveMetadata/);

assert.match(style, /Storyboard S3: unified prompt workbench/);
assert.match(style, /\.sd-storyboard-toggle-pills/);
assert.match(style, /\.sd-storyboard-compiler-toggle\.active/);

console.log('Storyboard prompt preprocessing workflow contract OK');
