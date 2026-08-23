import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

const friendRender = source.slice(source.indexOf('function renderReaderDialogMessages'), source.indexOf('function stripDialogQuotes'));
const assistantRender = source.slice(source.indexOf('function renderReaderAssistantMessages'), source.indexOf('function coreadRefreshAssistantPanel'));
const openAssistant = source.slice(source.indexOf('function coreadOpenAssistant'), source.indexOf('function coreadStopAssistant'));
const readerBindings = source.slice(source.indexOf('function bindReaderStageEvents'), source.indexOf('// ── 伴读中心：设定、记忆、注入与模型接口统一为一个全屏入口'));

// 两边气泡都能在触屏单击后展开工具；小助手只允许编辑与删除，不混入配音入口。
assert.match(friendRender, /sd-reader-msg-actions/);
assert.match(assistantRender, /sd-reader-assistant-actions/);
assert.match(assistantRender, /data-assistant-act="edit"/);
assert.match(assistantRender, /data-assistant-act="delete"/);
assert.doesNotMatch(assistantRender, /data-act="speak"|circle-play/, '幕伴小助手气泡不得显示配音功能');
assert.match(readerBindings, /assistantMessage\.classList\.toggle\('actions-open'\)/);
assert.match(readerBindings, /readerMessage\.classList\.toggle\('actions-open'\)/);
assert.match(css, /\.sd-reader-assistant-msg\.actions-open \.sd-reader-assistant-actions[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/);
assert.match(css, /\.sd-reader-msg\.actions-open \.sd-reader-msg-actions[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/);

// 编辑是用户主动动作，允许聚焦，但光标必须落在末尾；普通打开、切换、发送不得主动唤起输入法。
assert.match(readerBindings, /const end = ta\.value\.length[\s\S]*ta\.setSelectionRange\(end, end\)/);
assert.doesNotMatch(openAssistant, /\.focus\(/, '打开选区小助手不得自动唤起输入法');
assert.doesNotMatch(readerBindings, /dialogTa\?\.focus|dialogTa\.focus/, '切换对话或发送后不得主动唤起输入法');

// 单一发送键：单击只发送，长按才回复；旧的独立生成按钮已经移除。
assert.match(source, /coreadAppendAssistantMessage/);
assert.match(source, /coreadGenerateAssistantReply/);
assert.match(readerBindings, /const doReply = async \(\)[\s\S]*coreadGenerateAssistantReply\(\)[\s\S]*coreadGenerateReply\(false\)/);
assert.doesNotMatch(source, /class="sd-reader-inbtn sd-reader-dialog-gen"/);
assert.match(source, /单击发送；长按让 AI 回复；桌面双击或触屏上滑添加图片/);

console.log('Coread dialogue touch interaction contract OK');
