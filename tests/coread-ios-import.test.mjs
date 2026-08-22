import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

const shelfMarkup = source.slice(source.indexOf('function renderLibraryView'), source.indexOf('function buildReaderParagraphs'));
const shelfBinding = source.slice(source.indexOf('function bindLibraryViewEvents'), source.indexOf('function bindReaderPortalEvents'));

assert.match(shelfMarkup, /<label class="sd-reader-import sd-reader-import-fab"[\s\S]*<input type="file" class="sd-reader-import-input sd-reader-native-file"/, '书架导入必须由 label 直接关联常驻原生文件控件');
assert.doesNotMatch(shelfBinding, /\.sd-reader-import['"]\)\?\.addEventListener\(['"]click['"]/, '书架导入不得在点击回调中二次调用 input.click()');
assert.match(shelfBinding, /\.sd-reader-import-input['"]\)\?\.addEventListener\(['"]change['"][\s\S]*input\.value = ''[\s\S]*coreadHandleImportFiles\(files\)/, '文件选择后必须立即清空控件并进入支持连续图片的统一解析');
assert.match(source, /application\/x-mobipocket-ebook/, 'iOS 文件提供器的 MOBI MIME 类型必须受支持');
assert.match(css, /\.sd-reader-native-file\s*\{[\s\S]*opacity:\s*0[^}]*clip-path:\s*inset\(50%\)/, '文件控件必须视觉隐藏但不能使用 display:none');
assert.match(css, /\.sd-reader-import-fab \.sd-reader-import-input,[\s\S]*\.sd-reader-refill-pick \.sd-reader-refill-input\s*\{[^}]*inset:\s*0[^}]*width:\s*100%[^}]*height:\s*100%/, 'iOS 上原生文件控件本身必须覆盖书架和补正文按钮');

const refillChooser = source.slice(source.indexOf('function coreadShowRefillChooser'), source.indexOf('function coreadPurgeBookMemory'));
const openBook = source.slice(source.indexOf('async function coreadOpenBook'), source.indexOf('function coreadCloseReader'));
assert.match(refillChooser, /sd-reader-refill-pick[\s\S]*<input type="file" class="sd-reader-refill-input sd-reader-native-file"/, '跨设备补正文弹层必须内嵌原生文件控件');
assert.match(refillChooser, /\.sd-reader-refill-input['"]\)\?\.addEventListener\(['"]change['"][\s\S]*coreadHandleImportFiles\(files, bookId\)/, '补正文文件必须进入支持连续图片的统一解析并写回原书');
assert.doesNotMatch(refillChooser, /\.click\(\)/, '补正文入口不得再以脚本模拟文件控件点击');
assert.match(openBook, /coreadShowRefillChooser\(bookId\)/, '正文未缓存时必须打开 iOS 兼容的补正文选择层');
assert.doesNotMatch(openBook, /confirmDialog[\s\S]*coreadTriggerImport/, '正文未缓存路径不得等待确认后再触发文件选择');
assert.match(css, /\.sd-reader-refill-overlay\s*\{[^}]*position:\s*fixed[^}]*z-index:/, '补正文选择层必须覆盖当前书架界面');

const center = source.slice(source.indexOf('function renderCoreadPackBar'), source.indexOf('function renderCompanionMoreBody'));
const centerBinding = source.slice(source.indexOf("morePage?.addEventListener('change'"), source.indexOf("morePage?.addEventListener('input'"));
assert.match(center, /sd-reader-pack-import[\s\S]*<input type="file" class="sd-reader-pack-import-input sd-reader-native-file"/, '伴读中心数据包导入必须使用常驻原生文件控件');
assert.match(centerBinding, /sd-reader-pack-import-input[\s\S]*packInput\.value = ''[\s\S]*coreadImportDataFile\(file\)/, '伴读数据包选择后必须清空控件并进入统一导入器');
assert.match(css, /\.sd-reader-pack-import \.sd-reader-pack-import-input\s*\{[^}]*inset:\s*0[^}]*width:\s*100%[^}]*height:\s*100%/, '数据包文件控件必须覆盖导入图标以兼容 iOS');

console.log('Coread iOS import contract OK');
