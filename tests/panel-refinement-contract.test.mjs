import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

// 取材：身份独立成卡，上下文与层数同排；读取动作贴在选择栏尾部。
assert.match(source, /sd-context-identity-card[\s\S]*当前角色[\s\S]*当前用户[\s\S]*sd-context-reference-row[\s\S]*上下文参考[\s\S]*参考层数/);
assert.match(source, /sd-context-source-pick[\s\S]*<span>预设目录<\/span>[\s\S]*sd-refresh-presets/);
assert.match(source, /sd-context-source-pick[\s\S]*<span>世界书目录<\/span>[\s\S]*sd-refresh-worldbooks/);
assert.match(css, /\.sd-context-reference-row\s*\{[^}]*flex-wrap:\s*nowrap/);

// 幕后：注入范围与衍生模块使用同款选择标签；提示词与输出格式收进同一折叠卡。
assert.match(source, /sd-card-title-row[\s\S]*<h3>刷新<\/h3>[\s\S]*仅计入角色回复层/);
assert.match(source, /<h3>暗线注入正文<\/h3>/);
assert.doesNotMatch(source, /checkbox_label sd-inject-section/);
assert.match(source, /<h3>衍生模块<\/h3>[\s\S]*sd-derivative-options[\s\S]*<span>尘寰群生<\/span>[\s\S]*<span>世界格局<\/span>/);
assert.doesNotMatch(source, /sd-livestage-enabled|<span>伏笔显影<\/span>/);
assert.match(source, /data-acc="director-law"[\s\S]*<b>剧组之律<\/b>[\s\S]*一般无需改动[\s\S]*sd-system-prompt[\s\S]*sd-output-schema[\s\S]*sd-save-director-settings/);

// 幕外：设置可折叠、读取按钮图标化，指令与剧札独立；剧札数量紧随标题。
assert.match(source, /sd-theater-settings-fold[\s\S]*番外小剧场栏目组[\s\S]*sd-theater-refresh-preset/);
assert.match(source, /sd-theater-command-card[\s\S]*此幕指令/);
assert.match(source, /inlineCount:\s*true/);
assert.match(source, /sd-template-title[\s\S]*cfg\.inlineCount[\s\S]*sd-template-io-buttons/);

// 配音：模型和文字状态同行；重复人设链路与 MiniMax/ElevenLabs 高级连接入口彻底移除。
assert.match(source, /<h3>模型选择<\/h3>[\s\S]*sd-tts-model-row[\s\S]*sd-tts-provider[\s\S]*sd-tts-enabled/);
assert.match(source, /t\.enabled = !t\.enabled/);
assert.match(source, /<b>泛用音色<\/b><span class="sd-tts-sub">自动根据此库为NPC适配<\/span>/);
assert.match(source, /<summary><b>其他参数<\/b><\/summary>/);
assert.doesNotMatch(source, /人设参照|renderTtsExtractWorldBooks|ttsBuildExtractContext|高级连接/);
assert.match(source, /epEmoji\(name\)[\s\S]*htmlEscape\(url\)/);

// 全局卡片标题/说明与折叠高度统一；蜂巢可更贴近视口边缘。
assert.match(css, /主面板排版基线[\s\S]*font-size:\s*15px !important[\s\S]*font-size:\s*12px !important/);
assert.match(css, /直接作为卡片标题的折叠栏统一采用[\s\S]*min-height:\s*22px/);
assert.ok((source.match(/const margin = 4;/g) || []).length >= 2);

console.log('Panel refinement contract OK');
