import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.equal((source.match(/class="sd-reader-dialog-center"/g) || []).length, 1, '对话抽屉必须只有一个伴读中心入口');
assert.doesNotMatch(source, /class="sd-reader-dialog-(?:apiconf|setup|more)"/, '旧 API、设定和记忆分散入口必须移除');
assert.ok(source.includes('fa-book-open-reader"></i> 伴读中心'), '统一全屏页标题必须为伴读中心');
assert.match(source, /\['setup',[\s\S]*\['records',[\s\S]*\['inject',[\s\S]*\['api',/, '伴读中心必须提供四个直接 tab');
const centerStatus = source.slice(source.indexOf('function renderCoreadCenterStatus'), source.indexOf('function renderCompanionMoreBody'));
assert.ok(centerStatus.includes('sd-reader-spoiler-filter') && centerStatus.includes('进度外隔离'), '防剧透状态与开关必须常驻中心总览');
assert.match(source, /tab === 'setup'[\s\S]*renderCompanionSetupBody/, '伴读设定必须并入统一中心');

assert.ok(source.includes('sd-reader-archive-card'), '伴读档案必须使用卡片式绑定界面');
assert.ok(source.includes('sd-reader-memory-overview'), '记忆档案页必须先提供状态总览与常用管理动作');
assert.ok(source.includes('sd-reader-sm-chevron'), '记忆切片卡必须有明确折叠指示');
assert.match(css, /\.sd-reader-archive-grid[^}]*grid-template-columns: repeat\(2/, '档案在宽屏必须使用双列卡片');
assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.sd-reader-archive-grid[^}]*grid-template-columns: 1fr/, '档案在窄屏必须回落单列');
assert.match(css, /\.sd-reader-center-status[^}]*grid-template-columns:/, '伴读中心必须有独立状态总览布局');

console.log('Coread center UI contract OK');
