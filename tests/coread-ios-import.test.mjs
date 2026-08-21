import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

const shelfMarkup = source.slice(source.indexOf('function renderLibraryView'), source.indexOf('function buildReaderParagraphs'));
const shelfBinding = source.slice(source.indexOf('function bindLibraryViewEvents'), source.indexOf('function bindReaderPortalEvents'));

assert.match(shelfMarkup, /<label class="sd-reader-import sd-reader-import-fab"[\s\S]*<input type="file" class="sd-reader-import-input sd-reader-native-file"/, '书架导入必须由 label 直接关联常驻原生文件控件');
assert.doesNotMatch(shelfBinding, /\.sd-reader-import['"]\)\?\.addEventListener\(['"]click['"]/, '书架导入不得在点击回调中二次调用 input.click()');
assert.match(shelfBinding, /\.sd-reader-import-input['"]\)\?\.addEventListener\(['"]change['"][\s\S]*input\.value = ''[\s\S]*coreadHandleImportFile\(file\)/, '文件选择后必须立即清空控件并进入统一解析');
assert.match(source, /application\/x-mobipocket-ebook/, 'iOS 文件提供器的 MOBI MIME 类型必须受支持');
assert.match(css, /\.sd-reader-native-file\s*\{[\s\S]*opacity:\s*0[^}]*clip-path:\s*inset\(50%\)/, '文件控件必须视觉隐藏但不能使用 display:none');
assert.match(css, /\.sd-reader-import-fab \.sd-reader-import-input\s*\{[^}]*inset:\s*0[^}]*width:\s*100%[^}]*height:\s*100%/, 'iOS 上原生文件控件本身必须覆盖整个导入按钮');

console.log('Coread iOS import contract OK');
