import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.equal((source.match(/class="sd-reader-dialog-center"/g) || []).length, 1, '对话抽屉必须只有一个伴读中心入口');
assert.doesNotMatch(source, /class="sd-reader-dialog-(?:apiconf|setup|more)"/, '旧 API、设定和记忆分散入口必须移除');
assert.ok(source.includes('fa-book-open-reader"></i> 伴读中心'), '统一全屏页标题必须为伴读中心');
assert.match(source, /\['setup',[\s\S]*\['records',[\s\S]*\['inject',[\s\S]*\['api',/, '伴读中心必须提供四个直接 tab');
const centerStatus = source.slice(source.indexOf('function renderCoreadCenterStatus'), source.indexOf('function renderCoreadSpoilerGuard'));
const spoilerGuard = source.slice(source.indexOf('function renderCoreadSpoilerGuard'), source.indexOf('function renderCoreadGuide'));
assert.doesNotMatch(centerStatus, /sd-reader-spoiler-filter/, '防剧透开关不应继续挤在全局总览卡里');
assert.ok(spoilerGuard.includes('sd-reader-spoiler-filter') && spoilerGuard.includes('防全知剧透'), '防全知剧透必须保留独立开关');
assert.doesNotMatch(spoilerGuard, /<small>/, '防全知剧透卡不得再显示状态说明小字');
assert.match(source, /renderCoreadIdentity\('我', stUser, userAvatar/, '用户身份标签必须显示为“我”并使用当前人设头像');
assert.match(source, /context\?\.userAvatar[\s\S]*#chat \.mes\[is_user="true"\]/, '用户头像必须优先读取 ST 当前人设并提供聊天头像回退');
assert.match(css, /\.sd-reader-setup-guard\s*\{[^}]*min-height:\s*54px[^}]*padding:\s*13px 15px/, '防全知剧透卡必须为图标与开关保留稳定边距');
assert.match(source, /tab === 'setup'[\s\S]*renderCompanionSetupBody/, '伴读设定必须并入统一中心');

assert.ok(source.includes('sd-reader-archive-card'), '伴读档案必须使用卡片式绑定界面');
assert.ok(source.includes('sd-reader-memory-overview'), '记忆档案页必须先提供状态总览与常用管理动作');
assert.ok(source.includes('sd-reader-sm-chevron'), '记忆切片卡必须有明确折叠指示');
const archivePage = source.slice(source.indexOf('function renderCoreadArchivePage'), source.indexOf('async function coreadOpenArchivePage'));
assert.match(archivePage, /<details class="sd-reader-archive-card[\s\S]*sd-reader-archive-detail/, '伴读档案必须使用矩形折叠卡片');
assert.doesNotMatch(archivePage, /new Popup|POPUP_TYPE/, '伴读档案不得再叠加 ST 弹窗');
assert.match(source, /coreadCenterPage === 'archives'[\s\S]*renderCoreadArchivePage/, '伴读档案必须作为中心内部子页面渲染');
assert.match(css, /\.sd-reader-subpage-head[^}]*position:\s*sticky/, '中心内部子页面必须使用统一返回头');
assert.match(css, /\.sd-reader-center-status[^}]*grid-template-columns:/, '伴读中心必须有独立状态总览布局');

console.log('Coread center UI contract OK');
