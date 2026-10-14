import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

// 取材：身份独立成卡，上下文与层数同排；进入面板后自动读取，不再占用低频刷新按钮。
assert.match(source, /sd-context-identity-card[\s\S]*<em>CHAR<\/em>[\s\S]*<em>USER<\/em>[\s\S]*sd-context-reference-row[\s\S]*上下文参考[\s\S]*参考层数/);
assert.match(source, /sd-context-source-pick[\s\S]*<span>预设目录<\/span>/);
assert.match(source, /sd-context-source-pick[\s\S]*<span>世界书目录<\/span>/);
assert.doesNotMatch(source, /sd-refresh-presets|sd-refresh-worldbooks/);
assert.match(css, /\.sd-context-reference-row\s*\{[^}]*flex-wrap:\s*nowrap/);

// 幕后：注入范围与衍生模块使用同款选择标签；提示词与输出格式收进同一折叠卡。
assert.match(source, /sd-card-title-row[\s\S]*<h3>刷新<\/h3>[\s\S]*仅计入角色回复层/);
assert.match(source, /<h3>暗线注入正文<\/h3>/);
assert.match(css, /\.sd-injection-card > h3[\s\S]*background-clip:\s*text/);
assert.match(css, /\.sd-derivative-card > h3[\s\S]*background-clip:\s*text/);
assert.doesNotMatch(source, /checkbox_label sd-inject-section/);
assert.match(source, /<h3>衍生模块<\/h3>[\s\S]*sd-derivative-options[\s\S]*<span>尘寰群生<\/span>[\s\S]*<span>世界格局<\/span>/);
assert.doesNotMatch(source, /sd-livestage-enabled|<span>伏笔显影<\/span>/);
assert.match(source, /data-acc="director-law"[\s\S]*<b>剧组之律<\/b>[\s\S]*一般无需改动[\s\S]*sd-system-prompt[\s\S]*sd-output-schema[\s\S]*sd-save-director-settings/);

// 幕外：设置可折叠、预设不再提供低频刷新按钮，指令与剧札独立；剧札数量紧随标题。
assert.match(source, /sd-theater-settings-fold[\s\S]*番外小剧场栏目组/);
assert.doesNotMatch(source, /sd-theater-refresh-preset/);
assert.match(source, /recentOutputs[\s\S]*slice\(0, 3\)/);
assert.doesNotMatch(source, /最近一幕：/);
assert.match(source, /sd-theater-command-card[\s\S]*此幕指令/);
assert.match(source, /inlineCount:\s*true/);
assert.match(source, /sd-template-title[\s\S]*cfg\.inlineCount[\s\S]*sd-template-io-buttons/);

// 配音：模型和文字状态同行；重复人设链路与 MiniMax/ElevenLabs 高级连接入口彻底移除。
assert.match(source, /<h3>模型选择<\/h3>[\s\S]*sd-tts-model-row[\s\S]*sd-tts-provider[\s\S]*sd-tts-enabled/);
assert.match(source, /<label for="sd-tts-provider">配音模型<\/label>\s*<div class="sd-tts-model-row">\s*<select id="sd-tts-provider" class="text_pole sd-tts-provider" aria-label="配音模型"/);
assert.match(source, /<label for="sd-tts-extract-api">台词分析抓取模型<\/label>\s*<select id="sd-tts-extract-api"/);
assert.match(source, /t\.enabled = !t\.enabled/);
assert.match(source, /<b>泛用音色<\/b><span class="sd-tts-sub">自动根据此库为NPC适配<\/span>/);
assert.match(source, /<summary><b>其他参数<\/b><\/summary>/);
assert.doesNotMatch(source, /人设参照|renderTtsExtractWorldBooks|ttsBuildExtractContext|高级连接/);
assert.match(source, /epEmoji\(name\)[\s\S]*htmlEscape\(url\)/);
assert.match(source, /sd-tts-save-conn[\s\S]*fa-floppy-disk[\s\S]*保存/);
assert.match(source, /title:\s*'剧本库'[\s\S]*emptyText:\s*'空空如也'/);
assert.match(source, /title:\s*'台词指导方案库'[\s\S]*emptyText:\s*'空空如也'/);
assert.match(source, /sd-tts-model-card[^]*sd-tts-model-row[^]*台词分析抓取模型[^]*sd-tts-extract-api[^]*<\/section>/);

// 全局卡片标题/说明与折叠高度统一；蜂巢可更贴近视口边缘。
assert.match(css, /主面板排版基线[\s\S]*font-size:\s*15px !important[\s\S]*font-size:\s*12px !important/);
assert.match(css, /直接作为卡片标题的折叠栏统一采用[\s\S]*min-height:\s*22px/);
assert.match(css, /\.sd-current-blueprint-actions\s*\{[\s\S]*grid-template-columns:\s*repeat\(2/);
// 顶部小组件开关复用保存 API 的标准按钮，蜂巢内部命令仍保留原布局。
assert.equal((source.match(/class="sd-btn sd-widget-toggle /g) || []).length, 2);
assert.match(css, /\.sd-widget-toggle:not\(\.sd-btn\)\s*\{/);
assert.doesNotMatch(css, /\.sd-widget-toggle-row > \.sd-widget-toggle\s*\{[^}]*font-size:/);
assert.match(css, /\.sd-focus-settings > summary > span:first-child,[\s\S]*background-image:\s*var\(--qm-card-title-gradient\)/);
assert.match(css, /:is\(\.sd-tts-model-card, \.sd-model-config, \.sd-widget-card\) > h3,[\s\S]*width:\s*fit-content/);
assert.match(css, /\.sd-float-size-control label,[\s\S]*\.sd-wheel-custom-details > summary > b[\s\S]*font-size:\s*var\(--qm-type-body\)/);
assert.ok((source.match(/const margin = 4;/g) || []).length >= 2);

console.log('Panel refinement contract OK');
