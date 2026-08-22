import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.match(css, /\.sd-reader-hl-underline\s*\{[^}]*text-decoration-line:\s*underline\s*!important[^}]*text-decoration-style:\s*solid\s*!important/, '直线划线必须使用不可被 mark 边框吞掉的文字装饰线');

const stage = source.slice(source.indexOf('function buildReaderStage'), source.indexOf('function renderSummaryApiCard'));
assert.match(stage, /sd-reader-toc" style="height:\$\{listDrawerH\}px[\s\S]*sd-reader-toc-grip/, '目录、笔记和书签共用抽屉必须有固定可调高度');
assert.doesNotMatch(stage, /sd-reader-export|sd-reader-import-data|导出阅读数据|导入阅读数据/, '阅读页设置不得保留重复的导入导出按钮');
assert.match(stage, /data-act="highlight"[^>]*><i class="fa-solid fa-underline"/, '划线主按钮必须使用明确的下划线图标');
assert.match(stage, /data-act="copy" title="复制文字"><i class="fa-solid fa-copy"><\/i><\/button>[\s\S]*data-act="image" title="摘录成图"/, '选区工具必须以纯图标提供复制与摘录成图');
assert.match(stage, /data-act="remove"><i class="fa-solid fa-eraser"><\/i><span>取消划线<\/span>/, '只有取消划线动作保留文字说明');
assert.match(stage, /sd-reader-noteedit-tags[\s\S]*sd-reader-excerptoverlay/, '笔记编辑必须支持标签且提供独立摘录图片层');
assert.match(stage, /sd-reader-excerpt-canvas-wrap[\s\S]*sd-reader-excerpt-panel/, '摘录页必须将纯画布预览置于功能面板上方');
assert.match(stage, /min="10" max="20"[\s\S]*>页眉</, '摘录字号必须限制为 10–20 且强调色更名为页眉');
assert.match(stage, /sd-reader-excerpt-zoom-out[\s\S]*sd-reader-excerpt-zoomval[\s\S]*sd-reader-excerpt-zoom-fit/, '摘录预览必须提供缩放百分比与完整适应操作');
assert.match(stage, />样式<[^]*sd-reader-excerpt-fontfamily[^]*sd-reader-excerpt-font-add[^]*fa-solid fa-plus/, '摘录面板必须以样式命名并用加号添加 CSS 字体');

const notes = source.slice(source.indexOf('function renderReaderNotes'), source.indexOf('function renderReaderMarks'));
assert.match(notes, /sd-reader-notes-search[\s\S]*sd-reader-notes-filter[\s\S]*favorite/, '笔记列表必须支持搜索、类型筛选和收藏');
assert.match(notes, /sd-reader-note-copy[\s\S]*sd-reader-note-image[\s\S]*sd-reader-note-edit/, '每条摘录必须提供复制、图片与编辑操作');
assert.match(notes, /sd-reader-note-tools-toggle[\s\S]*sd-reader-note-tools" hidden/, '笔记卡工具必须在右侧折叠后按需展开');
assert.match(notes, /sd-reader-note-del[\s\S]*fa-trash/, '摘录卡删除操作必须使用垃圾桶图标');
assert.doesNotMatch(notes, /fa-magnifying-glass/, '笔记搜索框不得继续显示放大镜图标');
assert.match(notes, /sd-reader-note-tags/, '笔记列表必须呈现用户标签');

const excerpt = source.slice(source.indexOf('const COREAD_EXCERPT_PRESETS'), source.indexOf('/* ── 事件绑定'));
assert.match(excerpt, /paper:[\s\S]*night:[\s\S]*mist:/, '摘录图片必须提供千幕内置配色方案');
assert.match(excerpt, /coreadNotePlainText[\s\S]*coreadCopyText[\s\S]*coreadSaveExcerptImage/, '摘录必须同时支持文字复制与 PNG 图片输出');
assert.match(excerpt, /document\.createElement\('canvas'\)[\s\S]*\.toBlob\(resolve, 'image\/png'\)/, '图片输出必须使用本地原生画布而非外部截图依赖');
assert.match(excerpt, /coreadBuildExcerptCanvases[\s\S]*pages\.map[\s\S]*canvasStage\.appendChild\(canvases\[index\]\)/, '长摘录必须自动分页且预览直接显示最终下载画布');
assert.match(excerpt, /savedPresets[\s\S]*coreadRefreshExcerptPresetSelect/, '摘录图片必须支持保存用户自定义方案');
assert.match(excerpt, /coreadExcerptFontStack[\s\S]*g\.font = `500 28px \$\{fontStack\}`/, '用户字体必须只经由摘录 Canvas 字体栈生效并降低字重');
for (const font of ['文津宋体', '霞鹜文楷', '思源宋', '思源黑', '普利世']) assert.match(excerpt, new RegExp(font));
for (const removed of ['文渊黑体 SC', '汇文明朝体', '小赖字体 Mono', 'B2 Hana']) assert.doesNotMatch(excerpt, new RegExp(removed));
assert.match(excerpt, /fontsapi\.zeoseven\.com[\s\S]*createElement\('style'\)[\s\S]*coreadPromptExcerptCssFont/, '字体必须通过隔离的 CSS 载入，并支持用户命名后保存到下拉');
assert.match(source, /powerUserSettings[\s\S]*await import\(stMainScriptUrl\(\)\)[\s\S]*user_avatar/, '冷启动必须从 ST 模块读取当前人设头像');
assert.match(source, /PERSONA_CHANGED[\s\S]*personaChangedHandler/, '切换人设后必须同步刷新伴读头像');

const binding = source.slice(source.indexOf('function bindReaderStageEvents'), source.indexOf('// 目录 / 笔记 / 书签共用固定高度'));
assert.match(binding, /bindReaderListGrip[\s\S]*sd-reader-note-favorite[\s\S]*sd-reader-note-copy[\s\S]*sd-reader-note-image/, '阅读器必须接通抽屉高度记忆与笔记操作');
assert.match(binding, /stageRoot\.addEventListener\('click'[\s\S]*sd-reader-note-tools-toggle[\s\S]*row\.hidden = true/, '点笔记菜单外任意位置必须自动收起菜单');
assert.match(binding, /sel\.isCollapsed[\s\S]*!pendingMark[\s\S]*hideTools\(\)/, '用户取消正文选区时必须立即收起划线工具');
assert.match(binding, /toolInteracting[\s\S]*pointerdown[\s\S]*pointerup/, '划线工具必须用交互锁保护选区且不得再吞掉 iOS 点击');
assert.doesNotMatch(binding, /tools\.addEventListener\('pointerdown',\s*\(e\)[^]*e\.preventDefault/, '划线工具不得阻止 pointerdown 导致 iOS 点击失效');
assert.doesNotMatch(binding, /q\('\.sd-reader-export'\)|q\('\.sd-reader-import-data'\)/, '阅读页不得继续绑定已移除的导入导出入口');

assert.match(css, /\.sd-reader-toc\s*\{[^}]*max-height:\s*82%/, '目录抽屉必须限制高度并让正文区保持可用');
assert.match(css, /\.sd-reader-notes-toolbar\s*\{[^}]*position:\s*sticky/, '笔记搜索筛选栏必须固定在抽屉顶部');
assert.match(css, /\.sd-reader-excerptoverlay\s*\{[^}]*position:\s*absolute/, '摘录图片编辑层必须限制在阅读器内');
assert.match(css, /\.sd-reader-note-tools\s*\{[^}]*position:\s*absolute[^}]*right:\s*9px/, '笔记卡工具栏必须从卡片右侧展开');
assert.match(css, /\.sd-reader-excerpt-canvas-wrap\s*\{[^}]*overflow:\s*auto/, '摘录预览必须允许放大后滚动查看');
assert.match(css, /\.sd-reader-excerpt-canvas-wrap\s*\{[^}]*scrollbar-width:\s*none[\s\S]*\.sd-reader-excerpt-canvas-wrap::-webkit-scrollbar/, '摘录预览必须隐藏滚动条但保留滚动能力');
assert.match(css, /\.sd-reader-excerpt-canvas-wrap\.can-pan\s*\{[^}]*cursor:\s*grab/, '摘录预览放大后必须支持拖动查看');
assert.match(css, /\.sd-reader-morepage, \.sd-reader-morepage \*\s*\{[^}]*scrollbar-width:\s*none/, '伴读中心必须隐藏滚动条但保留滚动能力');
assert.match(css, /\.sd-reader-mainline-page > \.sd-reader-mllist\s*\{[^}]*overflow-y:\s*auto/, '主线选择页必须只让正文楼层列表滚动');

console.log('Coread reader notes contract OK');
