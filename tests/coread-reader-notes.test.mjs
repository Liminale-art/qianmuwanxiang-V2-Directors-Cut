import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

const stage = source.slice(source.indexOf('function buildReaderStage'), source.indexOf('function renderSummaryApiCard'));
assert.match(stage, /sd-reader-toc" style="height:\$\{listDrawerH\}px[\s\S]*sd-reader-toc-grip/, '目录、笔记和书签共用抽屉必须有固定可调高度');
assert.doesNotMatch(stage, /sd-reader-export|sd-reader-import-data|导出阅读数据|导入阅读数据/, '阅读页设置不得保留重复的导入导出按钮');
assert.match(stage, /data-act="highlight"><i class="fa-solid fa-wave-square"/, '划线主按钮必须使用波浪线图标');
assert.match(stage, /sd-reader-noteedit-tags[\s\S]*sd-reader-excerptoverlay/, '笔记编辑必须支持标签且提供独立摘录图片层');

const notes = source.slice(source.indexOf('function renderReaderNotes'), source.indexOf('function renderReaderMarks'));
assert.match(notes, /sd-reader-notes-search[\s\S]*sd-reader-notes-filter[\s\S]*favorite/, '笔记列表必须支持搜索、类型筛选和收藏');
assert.match(notes, /sd-reader-note-copy[\s\S]*sd-reader-note-image[\s\S]*sd-reader-note-edit/, '每条摘录必须提供复制、图片与编辑操作');
assert.match(notes, /sd-reader-note-tags/, '笔记列表必须呈现用户标签');

const excerpt = source.slice(source.indexOf('const COREAD_EXCERPT_PRESETS'), source.indexOf('/* ── 事件绑定'));
assert.match(excerpt, /paper:[\s\S]*night:[\s\S]*mist:/, '摘录图片必须提供千幕内置配色方案');
assert.match(excerpt, /coreadNotePlainText[\s\S]*coreadCopyText[\s\S]*coreadSaveExcerptImage/, '摘录必须同时支持文字复制与 PNG 图片输出');
assert.match(excerpt, /document\.createElement\('canvas'\)[\s\S]*canvas\.toBlob/, '图片输出必须使用本地原生画布而非外部截图依赖');

const binding = source.slice(source.indexOf('function bindReaderStageEvents'), source.indexOf('// 目录 / 笔记 / 书签共用固定高度'));
assert.match(binding, /bindReaderListGrip[\s\S]*sd-reader-note-favorite[\s\S]*sd-reader-note-copy[\s\S]*sd-reader-note-image/, '阅读器必须接通抽屉高度记忆与笔记操作');
assert.doesNotMatch(binding, /q\('\.sd-reader-export'\)|q\('\.sd-reader-import-data'\)/, '阅读页不得继续绑定已移除的导入导出入口');

assert.match(css, /\.sd-reader-toc\s*\{[^}]*max-height:\s*82%/, '目录抽屉必须限制高度并让正文区保持可用');
assert.match(css, /\.sd-reader-notes-toolbar\s*\{[^}]*position:\s*sticky/, '笔记搜索筛选栏必须固定在抽屉顶部');
assert.match(css, /\.sd-reader-excerptoverlay\s*\{[^}]*position:\s*absolute/, '摘录图片编辑层必须限制在阅读器内');

console.log('Coread reader notes contract OK');
