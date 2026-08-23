import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

const renderModal = source.slice(source.indexOf('function renderModal'), source.indexOf('function syncSettingsFromDOM'));
assert.match(renderModal, /modal\.onclick = \(event\) =>[\s\S]*event\.target === modal[\s\S]*\.sd-backdrop[\s\S]*closeModal\(\)/, '主面板必须允许点击窗口外任意遮罩区域关闭');
assert.match(renderModal, /\.sd-window'[\s\S]*stopPropagation/, '窗口内部点击不得误触点外关闭');

assert.match(css, /\.checkbox_label > input\[type="checkbox"\][\s\S]*width:\s*38px !important[\s\S]*border-radius:\s*999px !important/, '布尔设置必须统一为胶囊轨道');
assert.match(css, /\.checkbox_label > input\[type="checkbox"\]::after[\s\S]*border-radius:\s*50% !important/, '胶囊开关必须包含圆形滑块');
assert.match(css, /\.checkbox_label > input\[type="checkbox"\]:checked::after[\s\S]*translateX\(16px\)/, '开启态滑块必须移动到轨道右侧');
assert.doesNotMatch(css, /\.sd-lib-select[^\n{]*border-radius:\s*999px|\.sd-reader-book-check[^\n{]*border-radius:\s*999px/, '条目选择框不得被改成胶囊开关');

console.log('Modal switch and outside-dismiss contract OK');
