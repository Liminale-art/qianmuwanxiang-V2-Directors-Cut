import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.ok(source.includes('function currentDirectorInjectionText('), '必须有预览与实际注入共用的当前文本入口');
assert.match(source, /active \? currentDirectorInjectionText\(store\.plan\) : ''/, '扩展提示注入必须读取手动覆盖层');
assert.match(source, /const digest = currentDirectorInjectionText\(store\.plan\)/, '拦截器兜底注入必须读取同一覆盖层');
assert.match(source, /sd-edit-injection[\s\S]*fa-pencil/, '当前注入内容标题后必须保留铅笔入口');
assert.match(source, /target === 'sd-inject-preview'[\s\S]*injectOverride[\s\S]*applyDirectorInjection/, '保存修改后必须持久化并即时刷新实际注入');
assert.ok(source.includes('sd-editor-reset-injection'), '注入编辑页必须能够恢复自动生成');
assert.match(source, /injectionEditor \? '<button[^']*aria-label="返回"[^']*<\/button>'/, '注入编辑页返回按钮必须只有图标');
assert.match(source, /aria-label="恢复自动生成"><i[^>]*><\/i><\/button><button[^']*aria-label="保存"><i[^>]*><\/i><\/button>/, '注入编辑页恢复与保存按钮必须只有图标');
assert.equal((source.match(/sd-editor-tool-icon/g) || []).length, 3, '注入编辑页返回、恢复与保存必须共用同一图标规格');
assert.doesNotMatch(css, /\.sd-editor-tool-icon\.sd-editor-save i[^}]*transform:/, '保存与恢复图标必须使用完全相同的尺寸规则');
assert.match(source, /const editorLayout = !!editorView \|\| !!theaterView\?\.editing/, '通用文本编辑与幕外正文编辑必须启用同一独立滚动布局');
assert.match(source, /sd-body\$\{editorLayout \? ' sd-editor-body'/, '编辑态必须为主内容区挂载专用布局类');
assert.match(source, /sd-reader-card\$\{editing \? ' sd-editor-card sd-reader-editor-card'/, '幕外编辑态必须接入通用固定编辑框');
assert.match(css, /\.sd-sticky-bar\s*\{[^}]*z-index:\s*5[^}]*background:\s*var\(--sd-sticky-bg/, '同类顶栏必须使用主题实色隔离层防止正文穿透');
assert.ok((css.match(/--sd-sticky-bg:/g) || []).length >= 6, '六套外观都必须提供不透明顶栏底色');
assert.match(css, /\.sd-body\.sd-editor-body\s*\{[^}]*overflow:\s*hidden/, '编辑页外层不得继续承接正文滚动');
assert.match(css, /\.sd-editor-body > \.sd-editor-card\s*\{[^}]*flex:\s*1 1 0[^}]*overflow:\s*hidden/, '编辑卡必须固定占满剩余空间');
assert.match(css, /\.sd-editor-area\s*\{[^}]*flex:\s*1 1 0[^}]*overflow:\s*auto[^}]*resize:\s*none/, '编辑框必须固定尺寸并自行滚动');
assert.ok((source.match(/delete (?:store|getChatStore\(\))\.injectOverride/g) || []).length >= 3, '新推演、清空与载入历史必须解除旧覆盖');
assert.match(css, /sd-tts-fav-row\.sd-playing \.sd-tts-txt\.is-overflowing/, '收藏标题只能在播放且溢出时滚动');
assert.match(css, /prefers-reduced-motion: reduce/, '标题滚动必须尊重系统减少动态效果设置');

console.log('Director injection edit contract OK');
