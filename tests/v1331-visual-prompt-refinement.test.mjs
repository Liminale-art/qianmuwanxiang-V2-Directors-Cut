import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CREATIVE_SYSTEM_PROMPT, CREATIVE_GUIDES, CREATIVE_COUNTS } from '../qianmu-creative-prompts.js';
import { createCreativeSchema } from '../qianmu-creative-contract.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

// 取材身份向中间收束、长名字可自适应；已按后续精调移除冗余提示文案。
assert.doesNotMatch(source, /避免左右脑互搏建议只开所需|建议只开所需条目，避免冲突导致模型左右脑互搏/);
assert.match(css, /\.sd-context-identity-card \.sd-base-row\s*\{[^}]*width:\s*min\(100%, 540px\)[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(css, /\.sd-fixed-ref \.sd-info-tag\s*\{[^}]*overflow-wrap:\s*anywhere/);

// 台词指导方案库与剧札共用通用库工具栏，并采用同样的标题后数量标签。
const ttsSchemeCfg = source.slice(source.indexOf('function ttsSchemeLibraryCfg'), source.indexOf('function renderTtsFavoritesPlaceholder'));
assert.match(ttsSchemeCfg, /inlineCount:\s*true/);
assert.match(source, /sd-template-io-buttons[\s\S]*sd-lib-import-label[\s\S]*sd-lib-export-toggle/);
assert.doesNotMatch(source, /推荐方案随配音模型自动切换/);

// 注入范围与衍生模块共享选择标签，选中态用主题强调色；子折叠有独立视觉区域。
assert.match(source, /sd-option-chip sd-inject-section/);
assert.match(source, /sd-derivative-options[\s\S]*sd-option-chip[\s\S]*尘寰群生[\s\S]*世界格局/);
assert.doesNotMatch(source, /sd-livestage-enabled|<span>伏笔显影<\/span>/);
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
assert.match(css, /\.sd-geo-focused \.sd-geo-node\.sd-on \.sd-geo-node-focus-ring\s*\{[^}]*opacity: \.9/);
assert.doesNotMatch(css, /@keyframes sd-geo-focus-ring/);

// 已定稿的际遇取代旧任务职业框定；供给量与 USER 自主权仍须守住。
const systemPrompt = CREATIVE_SYSTEM_PROMPT;
const schemaPrompt = createCreativeSchema({ interludeType: 'theater' });
assert.match(source, /const DEFAULT_SYSTEM_PROMPT = CREATIVE_SYSTEM_PROMPT;/);
assert.match(source, /segments\.push\(creativeSectionGuidance\(run\.creativeOptions\)\)/);
assert.match(source, /segments\.push\(createCreativeSchema\(run\.creativeOptions\)\)/);
assert.equal(CREATIVE_COUNTS.quests.min, 5);
assert.match(systemPrompt, /禁止替 \{\{user\}\} 决定思想、情绪、立场与行动/);
assert.match(CREATIVE_GUIDES.quests, /具体可接近的情境/);
assert.match(CREATIVE_GUIDES.quests, /不写成向 \{\{user\}\} 布置目标、奖励和完成步骤的任务清单/);
assert.match(schemaPrompt, /不代替 USER 接受或行动/);
assert.doesNotMatch(schemaPrompt, /以第三人称描述.*心理和下一步安排/);
assert.match(systemPrompt, /按照故事内实际经过的时间和已满足的条件推进/);
assert.match(systemPrompt, /各方既能与 \{\{user\}\} 产生有来由的交集，也有独立于主角的事务/);

console.log('v1.33.1 visual and task-prompt refinement contract OK');
