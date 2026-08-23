import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.match(source, /collections:\s*\[\][\s\S]*libCollectionId:\s*''/, '伴读设置必须持久化合集与当前层级');

const collectionData = source.slice(source.indexOf('function coreadCollections'), source.indexOf('// 网格封面'));
assert.match(collectionData, /validBooks[\s\S]*claimedBooks[\s\S]*bookIds/, '合集迁移必须清理失效书目并保证一本书只有一个归属');
assert.match(collectionData, /function coreadMoveBooksToCollection[\s\S]*function coreadDissolveCollection/, '必须提供移动与安全解散合集的数据操作');
assert.match(collectionData, /书籍与阅读数据不会删除/, '解散合集必须明确不删除书籍与阅读数据');

const shelf = source.slice(source.indexOf('function renderLibraryBookItem'), source.indexOf('// 章节正文'));
assert.match(shelf, /Array\.from\(\{ length: 4 \}/, '网格合集封面必须由四格书封组成');
assert.match(shelf, /sd-reader-collection-card/, '合集必须适配网格视图');
assert.match(shelf, /sd-reader-collection-row/, '合集必须适配列表视图');
assert.match(shelf, /sd-reader-collection-head[\s\S]*sd-reader-collection-back/, '打开合集后必须提供清晰的层级标题与返回入口');
assert.match(shelf, /sd-reader-batch-collect/, '列表视图必须支持批量归入合集');

const binding = source.slice(source.indexOf('function bindLibraryViewEvents'), source.indexOf('function bindReaderStageEvents'));
assert.match(binding, /coreadCreateCollection[\s\S]*coreadRenameCollection[\s\S]*coreadDissolveCollection/, '书架必须绑定新建、重命名与解散合集操作');
assert.match(binding, /coreadChooseCollectionForBooks/, '批量整理必须调用统一的合集归类逻辑');
assert.match(source, /activeCollection[\s\S]*activeCollection\.bookIds\.unshift\(bookId\)/, '在合集内导入的新书必须留在当前合集');
assert.match(source, /for \(const collection of coreadCollections\(\)\) collection\.bookIds = collection\.bookIds\.filter/, '删除书籍必须同步清理合集索引');

assert.match(css, /sd-reader-collection-cover[\s\S]*grid-template-columns:\s*repeat\(2/, '四封面合集必须使用稳定的二乘二网格');
assert.match(css, /sd-reader-collection-head[\s\S]*sd-reader-collection-back/, '合集层级标题必须具备完整样式');

const exportBlock = source.slice(source.indexOf('async function coreadExportData'), source.indexOf('async function coreadImportDataFile'));
assert.match(exportBlock, /version: 5[\s\S]*prefs: coreadSanitizePackageValue\(coread\(\)\)/, 'v5 伴读数据包必须随偏好携带合集结构');

console.log('Coread shelf collections contract OK');
