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
assert.ok(defaults.promptCompiler.excludedTags.includes('think'));

const normalized = normalizeStoryboardState({
  contentRating: 'nsfw',
  paragraphMode: 'manual',
  manualParagraphIndex: 4,
  promptDraft: { artistString: 'artist: user-owned' },
  artistPresets: [{ id: 'a1', name: '私有画师串', value: 'artist: user-owned' }],
  selectedArtistPresetId: 'a1',
  promptCompiler: { enabled: true, worldMode: 'selected', worldEntryIds: ['book::1'], excludedTags: 'think,status' },
});
assert.equal(normalized.contentRating, 'nsfw');
assert.equal(normalized.paragraphMode, 'manual');
assert.equal(normalized.manualParagraphIndex, 4);
assert.equal(normalized.promptDraft.artistString, 'artist: user-owned');
assert.equal(normalized.artistPresets[0].value, 'artist: user-owned');
assert.deepEqual(normalized.promptCompiler.worldEntryIds, ['book::1']);

assert.match(source, /class="sd-storyboard-compiler-enabled"/, '提示词卡必须使用单一 LLM 协作开关');
assert.match(source, /data-storyboard-content-rating="sfw"[\s\S]*data-storyboard-content-rating="nsfw"/);
assert.match(source, /data-storyboard-paragraph-mode="auto"[\s\S]*data-storyboard-paragraph-mode="manual"/);
assert.match(source, /function storyboardCompilerWorldText[\s\S]*worldMode === 'selected'[\s\S]*fallback/);
assert.match(source, /storyboardStripExcludedBlocks\(item\.mes, state\.promptCompiler\.excludedTags\)/);
assert.match(source, /画师串完全由用户另行控制。不得建议、生成、改写/);
assert.doesNotMatch(source, /"artist_string"|"artist_suggestion"/, 'LLM 返回结构不得包含画师串建议字段');
assert.match(source, /const artistString = String\(state\.promptDraft\?\.artistString/);
assert.match(source, /sourceId === 'novel' \? `\$\{artistString\}, \$\{scenePrompt\}`/);
assert.match(source, /function storyboardSaveArtistPreset/);
assert.doesNotMatch(source, /state\.prompt = storyboardCleanMessageText\(chatMessage\.mes\)/, '正文入口不得把整楼直接写进最终提示词');
assert.match(source, /state\.promptDraft\.userEditedCompiled = state\.promptCompiler\.enabled/);
assert.match(source, /if \(!state\.prompt\.trim\(\) && state\.promptCompiler\.enabled\) await storyboardCompilePrompt/);
assert.match(source, /contentRating: state\.contentRating/);
assert.match(source, /\['presets', '取景方案'\]/);
assert.match(source, /sd-storyboard-tag-custom-category/);
assert.match(source, /sd-storyboard-tag-negative:not\(input\)/);
assert.match(style, /Storyboard S3: unified prompt workbench/);

console.log('Storyboard unified prompt workflow contract OK');
