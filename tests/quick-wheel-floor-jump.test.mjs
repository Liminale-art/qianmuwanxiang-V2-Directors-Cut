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
for (const id of ['tasksnodes', 'castworld', 'blueprint', 'context', 'settings', 'geopolitics', 'plug']) {
  assert.match(source, new RegExp(`id: '${id}'`));
}
assert.match(source, /轮盘最多显示 6 项/);
assert.match(source, /slotMap\s*=\s*\{[\s\S]*?6:\s*\[-3, -2, -1, 1, 2, 3\]/, '六个入口必须以悬浮球为中心上三下三');
assert.match(source, /button\.innerHTML = `<i class="fa-solid \$\{item\.icon\}"><\/i>`/, '轮盘按钮只显示图标');
assert.match(source, /sd-wheel-custom-details/, '自定义轮盘入口列表必须可折叠');
assert.match(source, /document\.addEventListener\('pointerdown', dismiss, true\)/, '轮盘必须在文档捕获阶段监听外部点击');
assert.match(source, /document\.removeEventListener\('pointerdown', dismiss, true\)/, '轮盘关闭时必须解除外部点击监听');
assert.match(source, /bindQuickWheelOutsideDismiss\(root\)/);

// 短按仍开主面板，长按才开轮盘；拖动超过阈值会取消长按。
assert.match(source, /setTimeout\(\(\) =>[\s\S]*?openQuickWheel\(btn\)[\s\S]*?300\)/);
assert.match(source, /if \(wheelOpened\) closeQuickWheel\(\)/);
assert.match(source, /openModal\(\);\s*\/\/ 无参=恢复上次停留的 tab/);

// 楼层窗保持纯数字导航，不创建正文预览列表。
assert.match(source, /sd-floor-top[\s\S]*sd-floor-bottom/);
assert.doesNotMatch(source, /sd-floor-nearby|sd-floor-row|floorMessagePreview/);
assert.match(source, /type="number" min="0"[\s\S]*jumpToChatFloor\(0\)/, '楼层编号必须与 ST mesid 一致，从0开始');

// 未加载楼层必须调用 ST 官方分页 API；AI 隐藏楼层保留并显式标记。
assert.match(source, /script\[src\$="\/script\.js"\]/);
assert.match(source, /await import\(stMainScriptUrl\(\)\)/);
assert.match(source, /st\.showMoreMessages\(messagesToLoad\)/);
assert.match(source, /function alignChatFloor[\s\S]*chatElement\.scrollTo/);
assert.match(source, /setTimeout\(\(\) => alignChatFloor\(target\), 420\)/);
assert.doesNotMatch(source, /AI 隐藏楼层保留原编号并可正常定位/);
assert.match(source, /window\.visualViewport/);
assert.match(source, /bindFloorNavigatorViewport\(root\)/);
assert.match(source, /viewport\?\.addEventListener\('resize', sync\)/);

assert.match(css, /#story-director-quick-wheel/);
assert.match(css, /#story-director-floor-nav/);
assert.match(css, /#story-director-floor-nav\s*\{[^}]*overflow-y:\s*auto/);
assert.match(css, /\.sd-floor-shell\s*\{[^}]*min-height:\s*100%[^}]*display:\s*flex/);
assert.doesNotMatch(css, /#story-director-floor-nav \.sd-floor-panel\s*\{[^}]*max-height:\s*100%[^}]*overflow:\s*hidden/);
assert.match(css, /#story-director-floor-nav\.sd-theme-dark/);
assert.match(css, /\.mes\.sd-floor-jump-hit/);

console.log('Quick wheel and floor jump contract OK');
