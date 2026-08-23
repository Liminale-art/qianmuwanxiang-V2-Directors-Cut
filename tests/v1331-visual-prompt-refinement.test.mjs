import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

// 取材身份向中间收束、长名字可自适应；提示文案按反馈精确替换。
assert.match(source, /避免左右脑互搏建议只开所需/);
assert.doesNotMatch(source, /建议只开所需条目，避免冲突导致模型左右脑互搏/);
assert.match(css, /\.sd-context-identity-card \.sd-base-row\s*\{[^}]*width:\s*min\(100%, 540px\)[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(css, /\.sd-fixed-ref \.sd-info-tag\s*\{[^}]*overflow-wrap:\s*anywhere/);

// 台词指导方案库与剧札共用通用库工具栏，并采用同样的标题后数量标签。
const ttsSchemeCfg = source.slice(source.indexOf('function ttsSchemeLibraryCfg'), source.indexOf('function renderTtsFavoritesPlaceholder'));
assert.match(ttsSchemeCfg, /inlineCount:\s*true/);
assert.match(source, /sd-template-io-buttons[\s\S]*sd-lib-import-label[\s\S]*sd-lib-export-toggle/);
assert.doesNotMatch(source, /推荐方案随配音模型自动切换/);

// 注入范围与衍生模块共享选择标签，选中态用主题强调色；子折叠有独立视觉区域。
assert.match(source, /sd-option-chip sd-inject-section/);
assert.match(source, /sd-derivative-options[\s\S]*sd-option-chip[\s\S]*伏笔显影[\s\S]*尘寰群生[\s\S]*世界格局/);
assert.match(css, /\.sd-option-chip:has\(input:checked\)\s*\{[^}]*--sd-accent/);
assert.match(css, /\.sd-inject-subfold\s*\{[^}]*border:[^}]*background:/);
assert.match(css, /\.sd-inject-subfold \+ \.sd-inject-subfold\s*\{[^}]*margin-top:\s*4px/, '注入范围与当前注入内容的间距须由 20px 缩减 80%');
assert.match(source, /sd-inject-title[\s\S]*token[^<]*<\/span><span class="sd-inject-meta">[\s\S]*sd-edit-injection/);

// 剧组之律默认只露出单一折叠标题，展开后才包含两份文本与操作按钮。
assert.match(source, /data-acc="director-law">\s*<summary><b>剧组之律<\/b><span class="sd-summary-note">一般无需改动<\/span><\/summary>[\s\S]*sd-system-prompt[\s\S]*sd-output-schema[\s\S]*sd-save-director-settings/);
assert.doesNotMatch(source, /data-acc="director-law"[^>]*\sopen(?:\s|>)/);

// 星核不再缩放位移：只用原位描边、辉光与虚线外环表达聚焦。
assert.doesNotMatch(source, /点选势力查看两层牵连，再点一次收起/);
assert.doesNotMatch(source, /<h3>势力格局<\/h3>/);
assert.match(source, /sd-geo-node-focus-ring/);
assert.doesNotMatch(css, /\.sd-geo-focused \.sd-geo-node\.sd-on \.sd-geo-node-dot\s*\{[^}]*transform:/);
assert.match(css, /\.sd-geo-focused \.sd-geo-node\.sd-on \.sd-geo-node-focus-ring\s*\{[^}]*stroke-dashoffset|@keyframes sd-geo-focus-ring/);

// 任务仅变更叙述人称：四个任务视角锚点一致为第三人称，原有核心约束仍在。
const systemPrompt = source.slice(source.indexOf('const DEFAULT_SYSTEM_PROMPT'), source.indexOf('const JSON_SCHEMA_TEXT'));
const schemaPrompt = source.slice(source.indexOf('const JSON_SCHEMA_TEXT'), source.indexOf('const STAGE_LADDER'));
const finalPrompt = source.slice(source.indexOf('【最终任务·发送前重申'), source.indexOf('【势·关系网·最后重申】'));
assert.match(systemPrompt, /第三人称向心视角/);
assert.match(systemPrompt, /quests采用以\{\{user\}\}为中心的第三人称/);
assert.match(schemaPrompt, /以第三人称描述 \{\{user\}\} 的行动、观察、心理和下一步安排/);
assert.match(finalPrompt, /任务用以 \{\{user\}\} 为中心的第三人称/);
assert.doesNotMatch(systemPrompt, /quests[^\n]*第一人称/);
for (const invariant of ['任务 5 条', 'NPC 是有完整生活的人', '任务可被选择、延后、转向', '时间段务必拉开层次']) {
  assert.match(systemPrompt, new RegExp(invariant));
}

console.log('v1.33.1 visual and task-prompt refinement contract OK');
