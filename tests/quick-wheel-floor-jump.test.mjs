import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

// 默认方案固定保留六个约定入口；自定义方案独立保存顺序与启用状态。
for (const id of ['dashboard', 'tts', 'coread', 'theater', 'imagegen', 'floor']) {
  assert.match(source, new RegExp(`id: '${id}'`));
}
assert.match(source, /quickWheelCustomOrder/);
assert.match(source, /quickWheelCustomEnabled/);
assert.match(source, /长按展开快捷轮盘/);

// 短按仍开主面板，长按才开轮盘；拖动超过阈值会取消长按。
assert.match(source, /setTimeout\(\(\) =>[\s\S]*?openQuickWheel\(btn\)[\s\S]*?300\)/);
assert.match(source, /if \(wheelOpened\) closeQuickWheel\(\)/);
assert.match(source, /openModal\(\);\s*\/\/ 无参=恢复上次停留的 tab/);

// 楼层窗仅渲染目标附近七条，不对千层聊天创建完整列表。
assert.match(source, /const start = Math\.max\(0, Math\.min\(total - 7, targetIndex - 3\)\)/);
assert.match(source, /const end = Math\.min\(total, start \+ 7\)/);
assert.match(source, /chat\.slice\(start, end\)/);

// 未加载楼层必须调用 ST 官方分页 API；AI 隐藏楼层保留并显式标记。
assert.match(source, /script\[src\$="\/script\.js"\]/);
assert.match(source, /await import\(scriptUrl\)/);
assert.match(source, /st\.showMoreMessages\(messagesToLoad\)/);
assert.match(source, /message\?\.is_system/);
assert.match(source, /AI 隐藏楼层保留原编号并可正常定位/);

assert.match(css, /#story-director-quick-wheel/);
assert.match(css, /#story-director-floor-nav/);
assert.match(css, /\.mes\.sd-floor-jump-hit/);

console.log('Quick wheel and floor jump contract OK');
