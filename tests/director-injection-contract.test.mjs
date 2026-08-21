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
assert.ok((source.match(/delete (?:store|getChatStore\(\))\.injectOverride/g) || []).length >= 3, '新推演、清空与载入历史必须解除旧覆盖');
assert.match(css, /sd-tts-fav-row\.sd-playing \.sd-tts-txt\.is-overflowing/, '收藏标题只能在播放且溢出时滚动');
assert.match(css, /prefers-reduced-motion: reduce/, '标题滚动必须尊重系统减少动态效果设置');

console.log('Director injection edit contract OK');
