import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CREATIVE_GUIDES, creativeSectionGuidance } from '../qianmu-creative-prompts.js';
import {
  PROMPT_CARD_TABS, normalizePromptOverrides, effectiveGuides, promptValue, promptChanged,
  withPromptValue, promptSnapshot, applyPromptSnapshot, promptFile, readPromptFile, renderPromptCardBody, promptTextareaClass,
} from '../qianmu-prompt-card.js';

const defaults = { systemPrompt: '默认剧组之律', outputSchema: '{"默认":true}' };
const esc = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

test('the card covers every section guide once, plus 剧组之律 and 输出格式; 幕外 is not on the card (user 2026-11-26)', () => {
  const keys = PROMPT_CARD_TABS.flatMap((tab) => tab.keys);
  assert.deepEqual(PROMPT_CARD_TABS.map((tab) => tab.label), ['剧组之律', '推演核心', '衍生栏目', '幕间拾趣']);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys.filter((key) => key in CREATIVE_GUIDES).sort(), Object.keys(CREATIVE_GUIDES).sort(), 'all 19 guides');
  assert.deepEqual(keys.filter((key) => !(key in CREATIVE_GUIDES)), ['systemPrompt', 'outputSchema']);
});

test('built-in text is used until the user changes an entry; clearing it or typing the original back returns to the default', () => {
  let settings = {};
  assert.equal(promptValue('quests', settings, defaults), CREATIVE_GUIDES.quests);
  assert.equal(promptChanged('quests', settings, defaults), false);
  settings = { ...settings, ...withPromptValue(settings, 'quests', '我的预演指引', defaults) };
  assert.equal(promptValue('quests', settings, defaults), '我的预演指引');assert.equal(promptChanged('quests', settings, defaults), true);
  assert.deepEqual(settings.promptOverrides.guides, { quests: '我的预演指引' });
  for (const back of ['   ', CREATIVE_GUIDES.quests]) {
    const next = { ...settings, ...withPromptValue(settings, 'quests', back, defaults) };
    assert.deepEqual(next.promptOverrides.guides, {}, JSON.stringify(back.slice(0, 5)));
  }
  assert.deepEqual(withPromptValue({}, 'systemPrompt', '', defaults), { systemPrompt: '默认剧组之律' });
  assert.deepEqual(withPromptValue({}, 'outputSchema', '自定格式', defaults), { outputSchemaText: '自定格式' });
  assert.throws(() => withPromptValue({}, 'nope', 'x', defaults));
  assert.deepEqual(normalizePromptOverrides({ guides: { quests: 'x', unknown: 'y', forum: '' } }).guides, { quests: 'x' }, 'unknown or empty entries are dropped');
});

test('an edited guide is what the 推演 request carries; untouched sections keep the approved text', () => {
  const overrides = withPromptValue({}, 'story_status', '我的命运之脉写法', defaults).promptOverrides;
  const guide = creativeSectionGuidance({ interludeType: 'forum' }, effectiveGuides(overrides));
  assert.match(guide, /### 命运之脉\n\n我的命运之脉写法/);
  assert.ok(guide.includes(CREATIVE_GUIDES.quests));
  assert.equal(creativeSectionGuidance({ interludeType: 'forum' }, effectiveGuides({})), creativeSectionGuidance({ interludeType: 'forum' }), 'no overrides: identical to before');
});

test('the 推演 request reads from the card; 幕外 keeps its fixed line', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /segments\.push\(creativeSectionGuidance\(run\.creativeOptions, effectiveGuides\(settings\.promptOverrides\)\)\);/);
  assert.match(source, /segments\.push\('以上正文片段是衔接背景/);
  assert.doesNotMatch(source, /effectiveTheaterContinuity|theaterContinuity/);
});

test('a preset or an exported file holds only what differs; applying one resets everything it does not mention', () => {
  let settings = { systemPrompt: '默认剧组之律', outputSchemaText: '{"默认":true}' };
  settings = { ...settings, ...withPromptValue(settings, 'forum', '论坛新写法', defaults) };
  settings = { ...settings, ...withPromptValue(settings, 'systemPrompt', '新的律', defaults) };
  const snap = promptSnapshot(settings, defaults);
  assert.deepEqual(snap, { guides: { forum: '论坛新写法' }, systemPrompt: '新的律' });
  const back = readPromptFile(JSON.parse(JSON.stringify(promptFile(snap))));
  const applied = applyPromptSnapshot(back, defaults);
  assert.deepEqual(applied, { promptOverrides: { guides: { forum: '论坛新写法' } }, systemPrompt: '新的律', outputSchemaText: '{"默认":true}' });
  assert.deepEqual(applyPromptSnapshot({}, defaults), { promptOverrides: { guides: {} }, systemPrompt: '默认剧组之律', outputSchemaText: '{"默认":true}' }, '内置默认');
  assert.equal(readPromptFile({ type: 'something-else', prompts: {} }), null);
  assert.equal(readPromptFile(null), null);
});

test('the card renders the preset row, four tabs with a dot where something changed, and the active tab’s entries', () => {
  const settings = { promptOverrides: { guides: { quests: '改' } } };
  const html = renderPromptCardBody({ settings, defaults, tab: 'core', presets: [{ id: 'p1', name: '我的<套>' }], selected: 'p1' }, esc);
  assert.match(html, /<option value="">内置默认<\/option>\s*<option value="p1" selected>我的&lt;套><\/option>/);
  assert.match(html, /sd-prompt-preset-del"[^>]*aria-label="删除选中预设">/);
  const tabs = [...html.matchAll(/data-tab="(\w+)" aria-pressed="(\w+)">([^<]+)(<span class="sd-prompt-tab-dot")?/g)].map((m) => [m[1], m[2], m[3], !!m[4]]);
  assert.deepEqual(tabs, [['laws', 'false', '剧组之律', false], ['core', 'true', '推演核心', true], ['derived', 'false', '衍生栏目', false], ['interlude', 'false', '幕间拾趣', false]]);
  // 恢复默认是右上角放大图标前的小图标，只在改过的条目上出现
  const quests = html.slice(html.indexOf('data-key="quests">'), html.indexOf('</summary>', html.indexOf('data-key="quests">')));
  assert.match(quests, /sd-prompt-reset" data-key="quests" title="恢复默认"[^>]*><i class="fa-solid fa-rotate-left"><\/i><\/button>\s*<button type="button" class="sd-icon-btn sd-icon-sm sd-expand-editor"/);
  const npc = html.slice(html.indexOf('data-key="npc_updates">'), html.indexOf('</summary>', html.indexOf('data-key="npc_updates">')));
  assert.doesNotMatch(npc, /sd-prompt-reset/);
  assert.doesNotMatch(html, />恢复默认<\/button>/);
  const entries = [...html.matchAll(/<details class="sd-prompt-entry( is-changed)?" data-key="(\w+)">/g)].map((m) => [m[2], !!m[1]]);
  assert.deepEqual(entries.map(([key]) => key), PROMPT_CARD_TABS[1].keys);
  assert.deepEqual(entries.filter(([, changed]) => changed).map(([key]) => key), ['quests']);
  assert.match(html, /class="text_pole sd-textarea sd-prompt-text sd-prompt-ta-npc-updates" data-key="npc_updates"/);
  assert.match(html, /data-target="sd-prompt-ta-quests"/);
  assert.doesNotMatch(html, /sd-restore-system/, '恢复上次 only on the 剧组之律 tab');
  const laws = renderPromptCardBody({ settings: {}, defaults, tab: 'laws', presets: [], selected: '', backup: true }, esc);
  assert.match(laws, /sd-system-prompt" data-key="systemPrompt"[^>]*>默认剧组之律<\/textarea>/);
  assert.match(laws, /sd-output-schema" data-key="outputSchema"/);
  assert.match(laws, /sd-restore-system"[^>]*>恢复上次/);assert.doesNotMatch(laws, /sd-restore-system"[^>]* disabled/);
  assert.match(laws, /sd-prompt-preset-del"[^>]* disabled/);
  assert.equal(promptTextareaClass('fourth_wall_diary'), 'sd-prompt-ta-fourth-wall-diary');
});
