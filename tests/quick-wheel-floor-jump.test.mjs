import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

// 更新后只沿用用户自定义入口，全部千幕 tab 均可选择，蜂巢最多八格。
assert.match(source, /quickWheelCustomOrder/);
assert.match(source, /quickWheelCustomEnabled/);
assert.match(source, /quickWheelScheme: 'custom'/);
assert.match(source, /长按展开蜂巢快捷盘/);
for (const id of ['dashboard', 'tasksnodes', 'castworld', 'blueprint', 'context', 'settings', 'theater', 'tts', 'coread', 'geopolitics', 'plug', 'imagegen', 'floor']) {
  assert.match(source, new RegExp(`id: '${id}'`));
}
assert.match(source, /QUICK_HIVE_MAX_ITEMS = 8/);
assert.match(source, /QUICK_HIVE_LAYOUTS[\s\S]*8:\s*\[\[-\.82, -\.92\]/, '八格必须使用环绕主 Logo 的 3-2-3 蜂巢布局');
assert.doesNotMatch(source, /<option value="default"[^>]*>默认方案<\/option>/, '不得再显示固定默认方案');
assert.match(source, /button\.innerHTML = item\.iconUrl[\s\S]*sd-wheel-external-logo[\s\S]*fa-solid \$\{item\.icon\}/, '蜂巢按钮只显示原生图标或第三方 Logo');
assert.match(source, /sd-wheel-core[\s\S]*FLOAT_LOGO_URL/, '正式 Logo 必须位于蜂巢中心');
assert.match(source, /is-black-gold[\s\S]*is-white-gold[\s\S]*is-gold-black/, '每次展开只随机分配黑金、白金与金黑配色');
assert.match(source, /minCenterX[\s\S]*maxCenterX[\s\S]*minCenterY[\s\S]*maxCenterY/, '贴边展开必须把完整蜂巢夹在可视区内');
assert.match(source, /sd-wheel-custom-details/, '蜂巢入口列表必须可折叠');
assert.match(source, /document\.addEventListener\('pointerdown', dismiss, true\)/, '轮盘必须在文档捕获阶段监听外部点击');
assert.match(source, /document\.removeEventListener\('pointerdown', dismiss, true\)/, '轮盘关闭时必须解除外部点击监听');
assert.match(source, /bindQuickWheelOutsideDismiss\(root\)/);

// 第三方悬浮窗使用非侵入式代理收纳：拖近捕获、隐藏原入口、代理点击、可解除且不搬动对方 DOM。
assert.match(source, /quickWheelDockedPlugins:\s*\[\]/);
assert.match(source, /function quickDockOnPointerMove[\s\S]*sd-dock-ready/);
assert.match(source, /document\.addEventListener\('pointerdown', quickDockOnPointerDown, true\)/);
assert.match(source, /drag\.moved && drag\.ready[\s\S]*quickDockAttach\(drag\.host, drag\.activator\)/);
assert.match(source, /host\.classList\.add\('sd-quick-docked-origin'\)|classList\.toggle\('sd-quick-docked-origin'/);
assert.match(source, /function quickDockRun[\s\S]*target\?\.click\?\.\(\)/, '代理蜂巢片必须唤起原插件入口');
const dockAttach = source.slice(source.indexOf('function quickDockAttach'), source.indexOf('function quickDockRemove'));
assert.doesNotMatch(dockAttach, /appendChild|replaceChild|insertBefore/, '收纳不得移动或重挂第三方插件 DOM');
assert.match(source, /sd-wheel-dock-remove/);

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
assert.match(css, /clip-path:\s*polygon\(25% 2%, 75% 2%, 100% 50%/, '蜂巢入口必须是六边形');
assert.match(css, /sd-wheel-hive-in[\s\S]*rotateY\(82deg\)/, '蜂巢片应有翻转入场效果');
assert.match(css, /\.sd-wheel-command\.is-external\s*\{[^}]*animation:\s*none[^}]*opacity:\s*1/, '第三方收纳片必须保持静态');
assert.match(css, /\.sd-quick-docked-origin\s*\{[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none/, '原插件入口只能视觉隐藏，不能从 DOM 删除');
assert.match(css, /prefers-reduced-motion:\s*reduce/, '蜂巢动态必须尊重系统减少动态设置');
assert.match(css, /#story-director-floor-nav/);
assert.match(css, /#story-director-floor-nav\s*\{[^}]*overflow-y:\s*auto/);
assert.match(css, /\.sd-floor-shell\s*\{[^}]*min-height:\s*100%[^}]*display:\s*flex/);
assert.doesNotMatch(css, /#story-director-floor-nav \.sd-floor-panel\s*\{[^}]*max-height:\s*100%[^}]*overflow:\s*hidden/);
assert.match(css, /#story-director-floor-nav\.sd-theme-dark/);
assert.match(css, /\.mes\.sd-floor-jump-hit/);

console.log('Quick wheel and floor jump contract OK');
