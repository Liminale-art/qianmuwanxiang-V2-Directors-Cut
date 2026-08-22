import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

const deletion = source.slice(source.indexOf('async function coreadPurgeBookMemory'), source.indexOf('/* ── 进入/退出阅读器'));
assert.match(deletion, /coreadClearBookDialogue[\s\S]*\.\.\.rec,[\s\S]*messages:\s*\[\]/, '默认删书必须只清短对话并保留桶内长期记忆字段');
assert.match(deletion, /retainedMemoryBooks[\s\S]*deleteMemory[\s\S]*coreadPurgeBookMemory/, '删书必须用轻档案保留记忆，并只在用户选择后永久清理');
assert.match(deletion, /okButton:\s*'删除记忆'[\s\S]*cancelButton:\s*'保留记忆'/, '记忆删除选择必须默认可明确保留');

const libraryBinding = source.slice(source.indexOf('function bindLibraryViewEvents'), source.indexOf('function bindReaderStageEvents'));
assert.match(libraryBinding, /等 \$\{ids\.length\} 本书/, '批量删书提示必须只展示首本书与总数');
assert.doesNotMatch(libraryBinding, /\.join\('、'\)/, '批量删书提示不得罗列全部书名');

assert.match(source, /声音抽屉是空的/, '语音条空白态必须使用约定短文案');
assert.match(source, /支持 EPUB、MOBI、TXT/, '空书架必须提示可导入格式');
assert.match(source, /sd-reader-noteedit-quote'\)\.textContent = text;/, '长笔记摘录必须完整显示，不得按字符截断');

console.log('Coread detail feedback contract OK');
