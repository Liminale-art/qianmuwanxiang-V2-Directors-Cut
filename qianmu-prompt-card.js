// 幕后「提示词」卡：千幕各版块的提示词在前端可见、可改（用户 2026-11-26 定，形式照忆幕的总结提示词）。
// 内置默认原文不动，用户改的是自己的一份覆盖：存在 settings.promptOverrides（栏目指引、幕外衔接说明），
// 剧组之律与输出格式沿用原来的 settings.systemPrompt／outputSchemaText。改完离开输入框即存，清空或改回原文即回到内置默认。
// 预设把这四类整套存下，可切换、导入、导出、删除；「内置默认」整套恢复出厂。
import { CREATIVE_GUIDES, CREATIVE_SECTION_LABELS } from './qianmu-creative-prompts.js?v=1.59.484';

// 幕外：正文片段之后那句衔接说明（输出格式标签是解析协议，不放出来改）。
export const THEATER_CONTINUITY_DEFAULT = '以上正文片段是衔接背景，请据此保持人物口吻、关系与既有事实一致；番外可自由延展想象，但不要与正文已发生的事实冲突。';

export const PROMPT_CARD_TABS = Object.freeze([
  { id: 'laws', label: '剧组之律', keys: ['systemPrompt', 'outputSchema'] },
  { id: 'core', label: '推演核心', keys: ['story_status', 'character_dynamics', 'npc_updates', 'quests', 'chain_reactions', 'relation_undercurrents'] },
  { id: 'derived', label: '衍生栏目', keys: ['world_chatter', 'geopolitics', 'parallel_scene', 'newcomer'] },
  { id: 'interlude', label: '幕间拾趣', keys: ['interlude', 'forum', 'phone', 'phone_chat', 'moments', 'microblog', 'fourth_wall', 'fourth_wall_diary', 'fourth_wall_scene'] },
  { id: 'theater', label: '幕外', keys: ['theaterContinuity'] },
]);

const GUIDE_KEYS = new Set(Object.keys(CREATIVE_GUIDES));
const LABELS = { systemPrompt: '剧组之律', outputSchema: '输出格式', theaterContinuity: '正文衔接说明', ...CREATIVE_SECTION_LABELS };
export const promptEntryLabel = key => LABELS[key] || key;

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value : '');

// 只留认得的栏目、非空的覆盖；与内置原文相同的不算覆盖。
export function normalizePromptOverrides(raw) {
  const source = plain(raw) ? raw : {}, guides = {};
  for (const [key, value] of Object.entries(plain(source.guides) ? source.guides : {})) {
    if (GUIDE_KEYS.has(key) && text(value).trim() && value !== CREATIVE_GUIDES[key]) guides[key] = value;
  }
  const continuity = text(source.theaterContinuity);
  return { guides, theaterContinuity: continuity.trim() && continuity !== THEATER_CONTINUITY_DEFAULT ? continuity : '' };
}

// 本轮实际用的栏目指引：有覆盖用覆盖，否则用内置原文。交给 creativeSectionGuidance 的第二个参数。
export function effectiveGuides(overrides) {
  const guides = normalizePromptOverrides(overrides).guides;
  return Object.fromEntries(Object.keys(CREATIVE_GUIDES).map(key => [key, guides[key] ?? CREATIVE_GUIDES[key]]));
}

export const effectiveTheaterContinuity = overrides => normalizePromptOverrides(overrides).theaterContinuity || THEATER_CONTINUITY_DEFAULT;

// defaults：{ systemPrompt, outputSchema }（这两份默认在 index.js）。
export function promptDefault(key, defaults = {}) {
  if (key === 'systemPrompt') return text(defaults.systemPrompt);
  if (key === 'outputSchema') return text(defaults.outputSchema);
  if (key === 'theaterContinuity') return THEATER_CONTINUITY_DEFAULT;
  return CREATIVE_GUIDES[key] ?? '';
}

export function promptValue(key, settings = {}, defaults = {}) {
  if (key === 'systemPrompt') return text(settings.systemPrompt) || promptDefault(key, defaults);
  if (key === 'outputSchema') return text(settings.outputSchemaText) || promptDefault(key, defaults);
  const overrides = normalizePromptOverrides(settings.promptOverrides);
  if (key === 'theaterContinuity') return overrides.theaterContinuity || THEATER_CONTINUITY_DEFAULT;
  return overrides.guides[key] ?? promptDefault(key, defaults);
}

export const promptChanged = (key, settings, defaults) => promptValue(key, settings, defaults) !== promptDefault(key, defaults);

// 写入一条：清空或与原文一致即回到内置默认。返回新的 settings 片段 { systemPrompt?, outputSchemaText?, promptOverrides }。
export function withPromptValue(settings = {}, key, value, defaults = {}) {
  const raw = text(value), useDefault = !raw.trim() || raw === promptDefault(key, defaults);
  if (key === 'systemPrompt') return { systemPrompt: useDefault ? promptDefault(key, defaults) : raw };
  if (key === 'outputSchema') return { outputSchemaText: useDefault ? promptDefault(key, defaults) : raw };
  const overrides = normalizePromptOverrides(settings.promptOverrides);
  if (key === 'theaterContinuity') return { promptOverrides: { ...overrides, theaterContinuity: useDefault ? '' : raw } };
  if (!GUIDE_KEYS.has(key)) throw new Error(`未知的提示词：${key}`);
  const guides = { ...overrides.guides };
  if (useDefault) delete guides[key]; else guides[key] = raw;
  return { promptOverrides: { ...overrides, guides } };
}

// 一整套的快照（预设、导出用）：只记与内置不同的部分。
export function promptSnapshot(settings = {}, defaults = {}) {
  const overrides = normalizePromptOverrides(settings.promptOverrides), out = { guides: overrides.guides };
  if (overrides.theaterContinuity) out.theaterContinuity = overrides.theaterContinuity;
  if (promptChanged('systemPrompt', settings, defaults)) out.systemPrompt = promptValue('systemPrompt', settings, defaults);
  if (promptChanged('outputSchema', settings, defaults)) out.outputSchema = promptValue('outputSchema', settings, defaults);
  return out;
}

// 套用一整套：快照里没有的一律回到内置默认。
export function applyPromptSnapshot(snapshot, defaults = {}) {
  const data = plain(snapshot) ? snapshot : {};
  return {
    promptOverrides: normalizePromptOverrides({ guides: data.guides, theaterContinuity: data.theaterContinuity }),
    systemPrompt: text(data.systemPrompt).trim() ? data.systemPrompt : promptDefault('systemPrompt', defaults),
    outputSchemaText: text(data.outputSchema).trim() ? data.outputSchema : promptDefault('outputSchema', defaults),
  };
}

export const PROMPT_FILE_TYPE = 'qianmu-prompts';
export const promptFile = snapshot => ({ type: PROMPT_FILE_TYPE, version: 1, prompts: snapshot });
// 导入：认得的文件返回快照，认不得返回 null。
export function readPromptFile(data) {
  if (!plain(data) || data.type !== PROMPT_FILE_TYPE || !plain(data.prompts)) return null;
  const p = data.prompts;
  return { guides: plain(p.guides) ? p.guides : {}, theaterContinuity: text(p.theaterContinuity), systemPrompt: text(p.systemPrompt), outputSchema: text(p.outputSchema) };
}

export function normalizePromptPresets(list, makeId) {
  return (Array.isArray(list) ? list : []).filter(plain).map(item => ({ id: String(item.id || makeId()), name: String(item.name || '未命名预设'), prompts: plain(item.prompts) ? item.prompts : {} }));
}

// 卡片主体：预设行 + 页签 + 当前页签的条目。条目是带标题的折叠块，改过的标「已改」并可单条恢复。
export function renderPromptCardBody({ settings = {}, defaults = {}, tab = 'core', presets = [], selected = '', backup = false }, esc) {
  const active = PROMPT_CARD_TABS.find(item => item.id === tab) || PROMPT_CARD_TABS[1];
  const changedIn = item => item.keys.filter(key => promptChanged(key, settings, defaults)).length;
  return `
    <div class="sd-prompt-presets">
      <select class="text_pole sd-prompt-preset-sel" aria-label="提示词预设">
        <option value="">内置默认</option>
        ${presets.map(p => `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <button type="button" class="sd-icon-btn sd-icon-sm sd-prompt-preset-save" title="存为预设" aria-label="存为预设"><i class="fa-solid fa-floppy-disk"></i></button>
      <button type="button" class="sd-icon-btn sd-icon-sm sd-prompt-import" title="导入" aria-label="导入"><i class="fa-solid fa-file-import"></i></button>
      <button type="button" class="sd-icon-btn sd-icon-sm sd-prompt-export" title="导出" aria-label="导出"><i class="fa-solid fa-file-export"></i></button>
      <button type="button" class="sd-icon-btn sd-icon-sm sd-prompt-preset-del" title="删除选中预设" aria-label="删除选中预设"${selected ? '' : ' disabled'}><i class="fa-solid fa-trash"></i></button>
    </div>
    <div class="sd-prompt-tabs" role="group" aria-label="提示词分组">${PROMPT_CARD_TABS.map(item => {
      const n = changedIn(item);
      return `<button type="button" class="sd-prompt-tab${item.id === active.id ? ' active' : ''}" data-tab="${item.id}" aria-pressed="${item.id === active.id}">${esc(item.label)}${n ? `<span class="sd-prompt-tab-dot" title="改过 ${n} 条"></span>` : ''}</button>`;
    }).join('')}</div>
    <div class="sd-prompt-entries" data-tab="${active.id}">${active.keys.map(key => renderPromptEntry(key, settings, defaults, esc)).join('')}
      ${active.id === 'laws' ? `<div class="sd-button-row"><button type="button" class="sd-btn sd-restore-system" title="找回更新前你上一次使用的剧组之律与输出格式"${backup ? '' : ' disabled'}>恢复上次</button></div>` : ''}
    </div>`;
}

const TEXTAREA_CLASS = { systemPrompt: 'sd-system-prompt', outputSchema: 'sd-output-schema' };
export const promptTextareaClass = key => TEXTAREA_CLASS[key] || `sd-prompt-ta-${key.replace(/_/g, '-')}`;

export function renderPromptEntry(key, settings, defaults, esc) {
  const changed = promptChanged(key, settings, defaults), cls = promptTextareaClass(key), label = promptEntryLabel(key);
  return `<details class="sd-prompt-entry${changed ? ' is-changed' : ''}" data-key="${esc(key)}">
      <summary><span class="sd-prompt-entry-title">${esc(label)}</span><span class="sd-prompt-entry-mark">已改</span>
        <button type="button" class="sd-icon-btn sd-icon-sm sd-expand-editor" data-target="${cls}" data-title="${esc(label)}" title="展开编辑" aria-label="展开编辑"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></button></summary>
      <textarea class="text_pole sd-textarea sd-prompt-text ${cls}" data-key="${esc(key)}" spellcheck="false">${esc(promptValue(key, settings, defaults))}</textarea>
      <div class="sd-prompt-entry-acts"><button type="button" class="sd-btn sd-prompt-reset" data-key="${esc(key)}"${changed ? '' : ' disabled'}>恢复默认</button></div>
    </details>`;
}
