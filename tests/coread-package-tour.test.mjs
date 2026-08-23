import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const store = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');

assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.sd-reader-lib-grid \.sd-reader-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/, '移动端和窄屏书架必须固定一行三本');

const exportBlock = source.slice(source.indexOf('async function coreadExportData'), source.indexOf('async function coreadImportDataFile'));
assert.match(exportBlock, /version: 5[\s\S]*credentialsIncluded: false/, '伴读整包必须使用 v5 且声明不含凭据');
assert.match(exportBlock, /comicDescriptions/, '伴读整包必须保存漫画视觉文字稿');
assert.match(exportBlock, /listReaderImages[\s\S]*listReaderVectorKeys[\s\S]*meta\?\.source === 'coread'[\s\S]*listRetLog/, '整包必须包含插图、向量、伴读语音和检索记录');
assert.match(exportBlock, /qianmu-coread-pack-/, '整包文件名必须与旧阅读数据包明确区分');

const packageHelpers = source.slice(source.indexOf('function coreadIsCredentialKey'), source.indexOf('async function coreadExportData'));
assert.match(packageHelpers, /apikey[\s\S]*accesskey[\s\S]*secretkey[\s\S]*authorization[\s\S]*password/, '导出必须过滤常见凭据字段');
assert.match(packageHelpers, /对象数组按 id\/name 对齐本机条目[\s\S]*coreadMergePackageValue/, '导入必须深合并并保留本机凭据');

const importBlock = source.slice(source.indexOf('async function coreadImportDataFile'), source.indexOf('function coreadImportData()'));
assert.match(importBlock, /putReaderImageByKey[\s\S]*putReaderVectors[\s\S]*bulkPutAudio[\s\S]*pushRetLog/, '导入必须恢复所有扩展存储');
assert.match(importBlock, /API 密钥沿用本机设置/, '导入确认必须明确凭据处理方式');
assert.match(store, /export async function listReaderImages[\s\S]*export async function putReaderImageByKey[\s\S]*export async function listReaderVectorKeys/, '存储层必须支持媒体与向量整包迁移');

assert.match(source, /<div class="sd-reader-mempty">尚无注入记录<\/div>/, '实际注入空态必须使用精简文案');
const setup = source.slice(source.indexOf('function renderCompanionSetupBody'), source.indexOf('function renderReaderVoiceClips'));
assert.match(setup, /对话与可见范围[\s\S]*renderCoreadPackBar\(\)/, '伴读数据打包必须位于伴读设定末尾');
assert.match(source, /<b>伴读数据打包<\/b>/, '数据迁移入口必须命名为伴读数据打包');

console.log('Coread package and guided tour contract OK');
