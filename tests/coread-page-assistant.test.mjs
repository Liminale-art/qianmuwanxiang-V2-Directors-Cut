import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

// 幕伴小助手必须与角色书友消息分池，并提供三档由用户决定的历史策略。
assert.match(source, /assistant:\s*\{[\s\S]*?historyMode:\s*'session'/);
assert.match(source, /readerAssistantSessions\s*=\s*new Map\(\)/);
assert.match(source, /assistantMessages:/, '随书保存模式必须进入伴读数据包所用的会话记录');
for (const mode of ['session', 'persistent', 'clear']) assert.match(source, new RegExp(`<option value="${mode}"`));
assert.match(source, /COREAD_ASSISTANT_CONTEXT_MESSAGES\s*=\s*12/);
assert.doesNotMatch(source, /sd-reader-assistant-recent|参考最近轮数/);

// UI：与伴读对话共用抽屉，从输入框左侧切换；不再占用阅读页悬浮空间。
assert.match(source, /sd-reader-assistant-switch/);
assert.match(source, /assistantMode \? 'fa-user' : 'fa-lightbulb'/, '幕伴小助手与书友切换必须分别使用灯泡和小人图标');
assert.doesNotMatch(source, /sd-reader-assistant-trigger|sd-reader-assistant-panel/);
assert.match(source, /data-act="assistant" title="问幕伴小助手"/);
assert.match(source, /coreadOpenAssistant\(text\)/);
const openAssistant = source.slice(source.indexOf('function coreadOpenAssistant'), source.indexOf('function coreadStopAssistant'));
assert.match(openAssistant, /querySelectorAll\('\.sd-reader-panel\.open'\)[\s\S]*classList\.remove\('open'\)[\s\S]*dialogPanel\?\.classList\.add\('open'\)/, '从选区打开小助手前必须关闭其他阅读抽屉，只保留对话面板');
assert.match(source, /function coreadStopAssistant/);
assert.match(source, /function coreadClearAssistantHistory/);
assert.match(source, /但愿你能不期而然地同我一起/);
assert.match(source, /<details class="sd-reader-mcard sd-reader-assistant-settings/);
assert.match(source, /幕伴小助手/);
assert.match(source, /清空助手对话历史/, '助手设置卡必须使用清楚的文字按钮清空历史');
assert.match(source, /<label class="sd-reader-mlab">识图模型<\/label>/, '漫画与图片模型选择必须使用“识图模型”标题');

// 模型必须可选择千幕已有 API 预设，且防剧透边界进入助手系统提示词。
assert.match(source, /function assistantApiConn\(\)[\s\S]*?settings\.apiProfiles/);
assert.match(source, /sd-reader-assistant-profile/);
assert.match(source, /不得透露、暗示或利用后文信息/);
assert.match(source, /【用户选中的文字】/);
assert.match(source, /【当前已读范围】/);

assert.match(css, /\.sd-reader-assistant-switch\s*\{/);
assert.doesNotMatch(css, /\.sd-reader-assistant-trigger\s*\{|\.sd-reader-assistant-panel\s*\{/);

// 本轮两个收尾项。
assert.doesNotMatch(source, /只提取字体 API 与 font-family/);
assert.match(source, /id: 'imagegen', label: '生图', icon: 'fa-paintbrush'/);

console.log('Coread page assistant contract OK');
