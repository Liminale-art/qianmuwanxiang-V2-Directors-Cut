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
const panelState = source.slice(source.indexOf('function coreadSetReaderActivePanel'), source.indexOf('function coreadOpenAssistant'));
assert.match(panelState, /readerView\.activePanel = active[\s\S]*stage\.dataset\.readerPanel = active \|\| 'none'[\s\S]*const isActive = panel\.dataset\.readerPanel === active[\s\S]*classList\.toggle\('open', isActive\)/, '阅读底部抽屉必须由唯一活动状态同步数据属性和 DOM class');
assert.match(openAssistant, /coreadSetReaderActivePanel\('dialog'\)/, '选区小助手必须通过统一状态管理器独占对话抽屉');
assert.match(source, /lvMain\.querySelector\('\[data-act="assistant"\]'\)\.onclick = \(event\)[\s\S]*event\.preventDefault\(\); event\.stopPropagation\(\)/, '选区小助手按钮必须截断点击冒泡与穿透链');
assert.match(css, /data-reader-panel="dialog"[^}]*> \.sd-reader-dialog[^}]*transform:\s*translateY\(0\)/, 'CSS 必须按唯一 data-reader-panel 硬约束抽屉显示');
assert.match(panelState, /panel\.hidden = true[\s\S]*setAttribute\('inert'[\s\S]*style\.setProperty\('display', 'none', 'important'\)/, '非活动抽屉必须物理退出渲染树与交互树，不能只依靠位移');
assert.match(source, /function currentReaderPortal\(\)[\s\S]*querySelectorAll\('\[id="sd-reader-portal"\]'\)[\s\S]*portals\[portals\.length - 1\][\s\S]*portal\.remove\(\)/, '必须主动收敛热更新或重复初始化留下的同名阅读 portal');
assert.match(source, /function unmountReaderPortal\(\)[\s\S]*querySelectorAll\('\[id="sd-reader-portal"\]'\)\.forEach\(\(portal\) => portal\.remove\(\)\)/, '退出阅读必须删除全部同名 portal，而不是只删除第一个');
assert.match(source, /function watchReaderPanelInvariant\([\s\S]*MutationObserver[\s\S]*coreadSetReaderActivePanel\(readerView\.activePanel \|\| ''\)/, '抽屉根节点遭旧事件或外部样式改写后必须自动恢复唯一活动态');
assert.match(source, /panelInputBlockedUntil = nowMs\(\) \+ 480[\s\S]*nowMs\(\) < Number\(readerView\.panelInputBlockedUntil/, '选区助手打开后的移动端幽灵点击窗口必须被拦截');
assert.match(source, /data-reader-panel="dialog"\$\{activePanel === 'dialog' \? ' aria-hidden="false"' : ' hidden inert aria-hidden="true"'\}/, '初始 HTML 也必须把非活动对话抽屉隐藏并设为 inert');
assert.match(source, /function coreadStopAssistant/);
assert.match(source, /function coreadClearAssistantHistory/);
assert.match(source, /但愿你能不期而然地同我一起/);
assert.match(source, /<details class="sd-reader-mcard sd-reader-assistant-settings/);
assert.match(source, /幕伴小助手/);
assert.match(source, /清空助手对话历史/, '助手设置卡必须使用清楚的文字按钮清空历史');
assert.match(source, /<select class="sd-reader-minput sd-reader-assistant-history-mode">[\s\S]*?<\/select>[\s\S]*?<div class="sd-reader-assistant-clear-row">[\s\S]*?sd-reader-assistant-history-clear/, '清空助手历史按钮必须独占设置卡底部一行');
assert.match(css, /\.sd-reader-assistant-settings \.sd-reader-assistant-history-clear[^}]*width:\s*100%[^}]*min-height:\s*38px[^}]*border:\s*1px solid/, '清空助手历史必须显示为卡片底部的通栏按钮');
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
