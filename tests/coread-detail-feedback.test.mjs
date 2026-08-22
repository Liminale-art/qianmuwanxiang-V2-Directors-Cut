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
assert.doesNotMatch(source, /text:\s*String\(text \|\| ''\)\.slice\(/, '新建摘录不得截断用户选择的长文本');
assert.match(source, /selectionSegments[\s\S]*segments:\s*\(Array\.isArray\(segments\)/, '跨段长文本必须保留完整摘录并记录逐段划线片段');

const library = source.slice(source.indexOf('function sortedLibraryBooks'), source.indexOf('function bindReaderStageEvents'));
assert.match(library, /lastReadAt-desc[^]*最近阅读/, '书架必须提供最近阅读排序');
assert.match(source, /async function coreadOpenBook[^]*meta\.lastReadAt = Date\.now\(\)/, '成功打开书籍时必须更新最近阅读时间');
assert.match(library, /sd-reader-card-edit/, '书架必须提供书名与作者编辑按钮');
assert.match(library, /coreadEditBookInfo\(el\.dataset\.book\)/, '书架编辑按钮必须接通书名与作者保存逻辑');
assert.match(source, /async function coreadEditBookInfo[^]*meta\.title = title[^]*blobStore\.putBook/, '编辑书籍信息必须同步轻量书架与本机正文元数据');

console.log('Coread detail feedback contract OK');
