import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.match(source, /collections:\s*\[\][\s\S]*libCollectionId:\s*''/, '伴读设置必须持久化合集与当前层级');

const collectionData = source.slice(source.indexOf('function coreadCollections'), source.indexOf('// 网格封面'));
assert.match(collectionData, /validBooks[\s\S]*claimedBooks[\s\S]*bookIds/, '合集迁移必须清理失效书目并保证一本书只有一个归属');
assert.match(collectionData, /function coreadMoveBooksToCollection[\s\S]*function coreadDissolveCollection/, '必须提供移动与安全解散合集的数据操作');
assert.match(collectionData, /confirmDialog\(`确定解散「\$\{collection\.name\}」？`, ''\)/, '解散合集必须使用单句确认文案');

const shelf = source.slice(source.indexOf('function renderLibraryBookItem'), source.indexOf('// 章节正文'));
assert.match(shelf, /Array\.from\(\{ length: 4 \}/, '网格合集封面必须由四格书封组成');
assert.match(shelf, /sd-reader-collection-card/, '合集必须适配网格视图');
assert.match(shelf, /sd-reader-collection-row/, '合集必须适配列表视图');
assert.match(shelf, /sd-reader-collection-head[\s\S]*sd-reader-collection-back/, '打开合集后必须提供清晰的层级标题与返回入口');
assert.match(shelf, /sd-reader-batch-collect/, '列表视图必须支持批量归入合集');
assert.match(shelf, /sd-reader-collection-create[\s\S]*sd-reader-batch-collect/, '新建合集入口必须紧邻并位于归入合集之前');
assert.match(shelf, /sd-reader-batch-collect" title="归入合集" disabled>归入合集</, '归入合集按钮必须只保留文字');
assert.match(shelf, /sd-reader-collection-remove-book/, '合集内必须支持移出指定书籍');

const binding = source.slice(source.indexOf('function bindLibraryBookDrag'), source.indexOf('function bindReaderStageEvents'));
assert.match(binding, /coreadCreateCollection[\s\S]*coreadRenameCollection[\s\S]*coreadDissolveCollection/, '书架必须绑定新建、重命名与解散合集操作');
assert.match(binding, /coreadChooseCollectionForBooks/, '批量整理必须调用统一的合集归类逻辑');
assert.match(binding, /function bindLibraryBookDrag[\s\S]*setTimeout\(activate, 380\)[\s\S]*pointermove[\s\S]*pointerup/, '封面模式必须以 Pointer Events 支持双端长按拖放');
assert.match(binding, /sd-reader-collection-drop-target[\s\S]*coreadMoveBooksToCollection/, '拖放命中合集必须提供反馈并执行统一归类逻辑');
assert.match(source, /activeCollection[\s\S]*activeCollection\.bookIds\.unshift\(bookId\)/, '在合集内导入的新书必须留在当前合集');
assert.match(source, /for \(const collection of coreadCollections\(\)\) collection\.bookIds = collection\.bookIds\.filter/, '删除书籍必须同步清理合集索引');

assert.match(css, /sd-reader-collection-cover[\s\S]*grid-template-columns:\s*repeat\(2/, '四封面合集必须使用稳定的二乘二网格');
assert.match(css, /sd-reader-collection-head[\s\S]*sd-reader-collection-back/, '合集层级标题必须具备完整样式');
assert.match(css, /sd-reader-book-drag-ghost[\s\S]*sd-reader-collection-drop-target|sd-reader-collection-drop-target[\s\S]*sd-reader-book-drag-ghost/, '长按拖放必须提供拖动预览与投放高亮');

assert.match(source, /promptInput\('新建书架合集', '', defaultName\)/, '新建合集弹窗不得显示重复字段说明');
assert.match(source, /仅书目信息会随千幕配置同步，书籍内容须选择原书文件重新导入。/, '跨端缺书提示必须使用精简准确文案');
assert.doesNotMatch(source, /也可稍后通过伴读数据打包完成迁移/, '跨端缺书弹窗不得继续展示旧迁移说明');

const exportBlock = source.slice(source.indexOf('async function coreadExportData'), source.indexOf('async function coreadImportDataFile'));
assert.match(exportBlock, /version: 5[\s\S]*prefs: coreadSanitizePackageValue\(coread\(\)\)/, 'v5 伴读数据包必须随偏好携带合集结构');

console.log('Coread shelf collections contract OK');
