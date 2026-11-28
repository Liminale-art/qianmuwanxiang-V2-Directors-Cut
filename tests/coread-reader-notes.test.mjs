import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {createCoreadPanelFixture} from './helpers/coread-panel-fixture.mjs';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.match(css, /\.sd-reader-hl-underline\s*\{[^}]*text-decoration-line:\s*underline\s*!important[^}]*text-decoration-style:\s*solid\s*!important/, '直线划线必须使用不可被 mark 边框吞掉的文字装饰线');

const stage = source.slice(source.indexOf('function buildReaderStage'), source.indexOf('function renderSummaryApiCard'));
assert.match(stage, /sd-reader-toc[^>]*data-reader-panel="toc"[^>]*style="height:\$\{listDrawerH\}px[\s\S]*sd-reader-toc-grip/, '目录、笔记和书签共用抽屉必须有固定可调高度');
assert.doesNotMatch(stage, /sd-reader-export|sd-reader-import-data|导出阅读数据|导入阅读数据/, '阅读页设置不得保留重复的导入导出按钮');
assert.match(stage, /data-act="highlight"[^>]*><i class="fa-solid fa-underline"/, '划线主按钮必须使用明确的下划线图标');
assert.match(stage, /data-act="copy" title="复制文字"><i class="fa-solid fa-copy"><\/i><\/button>[\s\S]*data-act="image" title="摘录成图"/, '选区工具必须以纯图标提供复制与摘录成图');
assert.match(stage, /data-act="remove"><i class="fa-solid fa-eraser"><\/i><span>取消划线<\/span>/, '只有取消划线动作保留文字说明');

const notes = createCoreadPanelFixture().renderReaderNotes({notes:[{id:'note',kind:'highlight',chapterIndex:0,text:'excerpt',annotation:'note',tags:['tag']}]});
assert.match(notes, /sd-reader-notes-search[\s\S]*sd-reader-notes-filter[\s\S]*favorite/, '笔记列表必须支持搜索、类型筛选和收藏');
assert.match(notes, /sd-reader-note-copy[\s\S]*sd-reader-note-image[\s\S]*sd-reader-note-edit/, '每条摘录必须提供复制、图片与编辑操作');
assert.match(notes, /sd-reader-note-tools-toggle[\s\S]*sd-reader-note-tools" hidden/, '笔记卡工具必须在右侧折叠后按需展开');
assert.match(notes, /sd-reader-note-del[\s\S]*fa-trash/, '摘录卡删除操作必须使用垃圾桶图标');
assert.doesNotMatch(notes, /fa-magnifying-glass/, '笔记搜索框不得继续显示放大镜图标');
assert.match(notes, /sd-reader-note-tags/, '笔记列表必须呈现用户标签');

// 书摘成图改用与正文收藏同一张排版台（2026-11-27）：旧的画布摘录层、配色与 CSS 字体都已去掉。
assert.doesNotMatch(stage, /sd-reader-excerptoverlay|sd-reader-excerpt-/, '阅读器里不再有旧的摘录图片层');
assert.match(stage, /sd-reader-noteedit-tags/, '笔记编辑必须支持标签');
const excerpt = source.slice(source.indexOf('async function coreadExcerptStudio'), source.indexOf('/* ── 事件绑定'));
assert.match(excerpt, /loadLocalChunk\('\.\/qianmu-excerpt-studio\.js'\)[\s\S]*mountPortal\(portal, \{ inheritTheme: true \}\)/, '伴读书摘成图懒加载排版台并套千幕主题');
assert.match(excerpt, /scope: 'reader'[\s\S]*dialogue: \{ messages: dialogue\.messages \}[\s\S]*lines: dialogue\.lines/, '伴读入口带上书友对话供选入');
assert.match(excerpt, /book: source\.book[\s\S]*note: note\.annotation/, '书名、作者与笔记作为占位字段交给排版台');
assert.match(source, /coreadNotePlainText[\s\S]*coreadCopyText/, '摘录仍可复制文字');
assert.doesNotMatch(source, /COREAD_EXCERPT_PRESETS|coreadBuildExcerptCanvases|fontsapi\.zeoseven\.com/, '旧的摘录画布、配色与外部 CSS 字体已移除');
assert.match(source, /powerUserSettings[\s\S]*await import\(stMainScriptUrl\(\)\)[\s\S]*user_avatar/, '冷启动必须从 ST 模块读取当前人设头像');
assert.match(source, /PERSONA_CHANGED[\s\S]*personaChangedHandler/, '切换人设后必须同步刷新伴读头像');

// S1：笔记离开设置，存在 reader_notes（一本书一条记录），开书时读进 readerView.notes；设置里只留条数。
const noteFns = ['coreadAddHighlight', 'coreadDeleteNote', 'coreadToggleBookmark', 'coreadFindReaderNote', 'saveNoteEdit', 'openReaderNoteDialog', 'updateReaderArticle', 'coreadPickCandidate']
  .map(name => [name, source.slice(source.indexOf(`function ${name}(`), source.indexOf('\n}\n', source.indexOf(`function ${name}(`)))]);
for (const [name, body] of noteFns) {
  assert.ok(body.length > 40, name);
  assert.doesNotMatch(body, /meta\??\.notes/, `${name} no longer reads or writes the frozen meta.notes`);
}
assert.match(noteFns.find(([n]) => n === 'coreadAddHighlight')[1], /from: place \? start \+ place\.from : null, to: place \? start \+ place\.to : null[\s\S]*coreadNotesCommit\(view\)/, '新划线按选区存全局位置');
assert.match(stage, /const chHi = coreadChapterMarks\(ci\);[\s\S]*renderReaderNotes\(notesSource\)[\s\S]*renderReaderMarks\(notesSource\)/, '阅读台从笔记记录取划线与列表');
const commit = source.slice(source.indexOf('function coreadNotesCommit'), source.indexOf('// 账户取回或删掉了某几本书的笔记'));
assert.match(commit, /meta\.noteCount = count|coreadSyncNoteCount\(view\)/);assert.doesNotMatch(commit, /saveSettings\(\)/, '改一条笔记不再上传整份设置（条数变了才由 coreadSyncNoteCount 存）');

// 「未定位」一组：找不到原处的旧划线照常能编辑、删除，但没有定位；同一句话的另外几处各一张卡，可定位、留下、不要。
const loose = createCoreadPanelFixture().renderReaderNotes({notes:[
  {id:'placed',kind:'highlight',from:3,to:7,ch:1,text:'有位置',at:2,candidates:[{from:40,to:44},{from:90,to:94}]},
  {id:'lost',kind:'highlight',from:null,to:null,ch:4,text:'找不到',at:1}]});
assert.match(loose, /sd-reader-notes-list">[\s\S]*data-note="placed"[\s\S]*<\/div><div class="sd-reader-notes-group">未定位<\/div><div class="sd-reader-notes-list sd-reader-notes-loose">/);
const looseGroup = loose.slice(loose.indexOf('sd-reader-notes-loose'));
assert.match(looseGroup, /data-note="lost"[\s\S]*sd-reader-note-where">第5节[\s\S]*sd-reader-note-edit[\s\S]*sd-reader-note-del/);
assert.doesNotMatch(looseGroup.slice(0, looseGroup.indexOf('sd-reader-note-pick')), /sd-reader-note-jump/, '未定位的划线没有定位按钮');
assert.equal((looseGroup.match(/sd-reader-note-item sd-reader-note-pick/g) || []).length, 2);
assert.match(looseGroup, /data-pick="1"[\s\S]*sd-reader-note-pickjump[\s\S]*sd-reader-note-keep[\s\S]*fa-check[\s\S]*sd-reader-note-drop[\s\S]*fa-xmark/);
assert.doesNotMatch(createCoreadPanelFixture().renderReaderNotes({notes:[{id:'old',kind:'highlight',chapterIndex:2,text:'旧形状'}]}), /未定位/, '还没换算的旧形状不算未定位');

const binding = source.slice(source.indexOf('function bindReaderStageEvents'), source.indexOf('// 目录 / 笔记 / 书签共用固定高度'));
assert.match(binding, /sd-reader-note-pickjump, \.sd-reader-note-keep, \.sd-reader-note-drop[\s\S]*coreadPickCandidate\(stageRoot, pickBtn\)/, '未定位里的三个按钮接通');
assert.match(binding, /bindReaderListGrip[\s\S]*sd-reader-note-favorite[\s\S]*sd-reader-note-copy[\s\S]*sd-reader-note-image/, '阅读器必须接通抽屉高度记忆与笔记操作');
assert.match(binding, /stageRoot\.addEventListener\('click'[\s\S]*sd-reader-note-tools-toggle[\s\S]*row\.hidden = true/, '点笔记菜单外任意位置必须自动收起菜单');
assert.match(binding, /sel\.isCollapsed[\s\S]*!pendingMark[\s\S]*hideTools\(\)/, '用户取消正文选区时必须立即收起划线工具');
assert.match(binding, /toolInteracting[\s\S]*pointerdown[\s\S]*pointerup/, '划线工具必须用交互锁保护选区且不得再吞掉 iOS 点击');
assert.doesNotMatch(binding, /tools\.addEventListener\('pointerdown',\s*\(e\)[^]*e\.preventDefault/, '划线工具不得阻止 pointerdown 导致 iOS 点击失效');
assert.doesNotMatch(binding, /q\('\.sd-reader-export'\)|q\('\.sd-reader-import-data'\)/, '阅读页不得继续绑定已移除的导入导出入口');

assert.match(css, /\.sd-reader-toc\s*\{[^}]*max-height:\s*82%/, '目录抽屉必须限制高度并让正文区保持可用');
assert.match(css, /\.sd-reader-notes-toolbar\s*\{[^}]*position:\s*sticky/, '笔记搜索筛选栏必须固定在抽屉顶部');
assert.match(css, /\.sd-reader-note-tools\s*\{[^}]*position:\s*absolute[^}]*right:\s*9px/, '笔记卡工具栏必须从卡片右侧展开');
assert.match(css, /\.sd-reader-morepage, \.sd-reader-morepage \*\s*\{[^}]*scrollbar-width:\s*none/, '伴读中心必须隐藏滚动条但保留滚动能力');
assert.doesNotMatch(css, /\.sd-reader-mainline-page/, '主线选择页已移除，不再保留其样式');

console.log('Coread reader notes contract OK');
