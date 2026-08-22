import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

// 页边助手必须与角色书友消息分池，并提供三档由用户决定的历史策略。
assert.match(source, /assistant:\s*\{[\s\S]*?historyMode:\s*'session'[\s\S]*?recentTurns:\s*12/);
assert.match(source, /readerAssistantSessions\s*=\s*new Map\(\)/);
assert.match(source, /assistantMessages:/, '随书保存模式必须进入伴读数据包所用的会话记录');
for (const mode of ['session', 'persistent', 'clear']) assert.match(source, new RegExp(`<option value="${mode}"`));

// UI：页边胶囊、独立侧栏、选中文字提问、停止与清空均需可达。
assert.match(source, /sd-reader-assistant-trigger/);
assert.match(source, /sd-reader-assistant-panel/);
assert.match(source, /data-act="assistant" title="问页边助手"/);
assert.match(source, /coreadOpenAssistant\(text\)/);
assert.match(source, /function coreadStopAssistant/);
assert.match(source, /function coreadClearAssistantHistory/);

// 模型必须可选择千幕已有 API 预设，且防剧透边界进入助手系统提示词。
assert.match(source, /function assistantApiConn\(\)[\s\S]*?settings\.apiProfiles/);
assert.match(source, /sd-reader-assistant-profile/);
assert.match(source, /不得透露、暗示或利用后文信息/);
assert.match(source, /【用户选中的文字】/);
assert.match(source, /【当前已读范围】/);

assert.match(css, /\.sd-reader-assistant-trigger\s*\{/);
assert.match(css, /\.sd-reader-assistant-panel\.open/);
assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.sd-reader-assistant-panel/);

// 本轮两个收尾项。
assert.doesNotMatch(source, /只提取字体 API 与 font-family/);
assert.match(source, /id: 'imagegen', label: '生图', icon: 'fa-paintbrush'/);

console.log('Coread page assistant contract OK');
