import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

// 更新后只沿用用户自定义入口，全部千幕 tab 均可自由选择，不设置可见的产品上限。
assert.match(source, /quickWheelCustomOrder/);
assert.match(source, /quickWheelCustomEnabled/);
assert.match(source, /quickWheelScheme: 'custom'/);
assert.match(source, /长按展开蜂巢快捷盘/);
for (const id of ['dashboard', 'tasksnodes', 'castworld', 'context', 'settings', 'theater', 'tts', 'coread', 'geopolitics', 'plug', 'imagegen', 'floor']) {
  assert.match(source, new RegExp(`id: '${id}'`));
}
const quickCommands = source.slice(source.indexOf('const QUICK_COMMANDS'), source.indexOf('const QUICK_COMMAND_IDS'));
assert.doesNotMatch(quickCommands, /id: 'blueprint'/, '编剧已并入幕后，不得继续占用蜂巢入口');
assert.match(quickCommands, /id: 'settings', label: '幕后', icon: 'fa-feather-pointed'/, '幕后蜂巢入口必须改用羽毛笔');
assert.match(source, /QUICK_HIVE_SAFETY_LIMIT = 24/, '仅保留异常配置安全阀，不得再把八格当作产品限制');
assert.doesNotMatch(source, /QUICK_HIVE_MAX_ITEMS|最多显示 \$\{QUICK_HIVE/, '设置页不得再显示蜂巢入口上限');
assert.match(source, /function quickHiveAxialRing[\s\S]*function quickHiveLayout/, '蜂巢必须使用通用轴向六角坐标生成器');
assert.doesNotMatch(source, /<option value="default"[^>]*>默认方案<\/option>/, '不得再显示固定默认方案');
assert.match(source, /button\.innerHTML = item\.external \? quickDockIconMarkup\(item\)/, '第三方 Logo 必须经过安全视觉描述渲染');
assert.match(source, /btn\.innerHTML = `<img src="\$\{FLOAT_LOGO_URL\}"/, '正式 Logo 必须继续使用真实悬浮窗');
assert.doesNotMatch(source, /sd-wheel-core/, '展开时不得再创建会使锚点跳位的替代中心按钮');
assert.match(source, /is-glass-light is-edge-graphite[\s\S]*is-glass-light is-edge-gold[\s\S]*is-glass-dark is-edge-ivory[\s\S]*is-glass-dark is-edge-gold/, '每个蜂巢片必须从规定的明暗玻璃与边线组合中取样');
assert.doesNotMatch(source, /wheelTheme[\s\S]*sd-theme-\$\{wheelTheme\}/, '展开蜂巢不再跟随面板主题换色');
const renderFloat = source.slice(source.indexOf('function renderFloatButton'), source.indexOf('function renderBusyState'));
assert.doesNotMatch(renderFloat, /sd-theme-|THEME_KEYS/, '主悬浮窗必须维持固定极简视觉，不再挂载面板主题类');
assert.match(source, /quickHiveDirectionalCells[\s\S]*edgeDirected/, '贴边展开必须从页面可用空间选择蜂巢格，不能移动主锚点');
assert.match(source, /originCenterX[\s\S]*quickHiveLayout[\s\S]*originCenterX \+ slot\.x/, '所有入口必须以真实悬浮窗中心定位');
assert.match(source, /classList\.add\('sd-wheel-active'\)/);
assert.match(source, /sd-wheel-custom-details/, '蜂巢入口列表必须可折叠');
assert.match(source, /document\.addEventListener\('pointerdown', dismiss, true\)/, '轮盘必须在文档捕获阶段监听外部点击');
assert.match(source, /document\.removeEventListener\('pointerdown', dismiss, true\)/, '轮盘关闭时必须解除外部点击监听');
assert.match(source, /bindQuickWheelOutsideDismiss\(root\)/);
assert.match(source, /function bindQuickWheelUndockDrag[\s\S]*releaseDistance[\s\S]*quickDockRemove\(key, false\)/, '第三方蜂巢片必须支持向外拖出解除收纳');
assert.match(source, /bindQuickWheelUndockDrag\(button, item, layout\)/);

// 第三方悬浮窗使用非侵入式代理收纳：拖近捕获、隐藏原入口、代理点击、可解除且不搬动对方 DOM。
assert.match(source, /quickWheelDockedPlugins:\s*\[\]/);
assert.match(source, /function quickDockOnPointerMove[\s\S]*sd-dock-ready/);
assert.match(source, /function quickDockSanitizeSvg[\s\S]*foreignObject[\s\S]*javascript:/, '内联 SVG 必须清理脚本、外部对象和危险属性');
assert.match(source, /maskImage[\s\S]*webkitMaskImage/, '第三方图标识别必须覆盖 CSS mask');
assert.match(source, /quickDockBindIconFallback[\s\S]*addEventListener\('error'/, '第三方图片失败时必须显示占位图标而非破图');
assert.match(source, /document\.addEventListener\('pointerdown', quickDockOnPointerDown, true\)/);
assert.match(source, /drag\.moved && drag\.ready[\s\S]*quickDockAttach\(drag\.host, drag\.activator\)/);
assert.match(source, /host\.classList\.add\('sd-quick-docked-origin'\)|classList\.toggle\('sd-quick-docked-origin'/);
assert.match(source, /function quickDockRun[\s\S]*target\?\.click\?\.\(\)/, '代理蜂巢片必须唤起原插件入口');
const dockAttach = source.slice(source.indexOf('function quickDockAttach'), source.indexOf('function quickDockRemove'));
assert.doesNotMatch(dockAttach, /appendChild|replaceChild|insertBefore/, '收纳不得移动或重挂第三方插件 DOM');
assert.match(source, /sd-wheel-dock-remove/);
const wheelSettings = source.slice(source.indexOf('function renderQuickWheelSettings'), source.indexOf('function renderPlugTab'));
assert.match(wheelSettings, /sd-wheel-custom-details[\s\S]*sd-wheel-docked-list[\s\S]*<\/details>/, '已收纳悬浮窗必须并入蜂巢入口折叠区');

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
assert.match(css, /--sd-wheel-item-height/);
assert.match(css, /clip-path:\s*polygon\(25% 0, 75% 0, 100% 50%/, '蜂巢入口必须是无畸变边角的正六边形');
assert.match(css, /#story-director-float\s*\{[^}]*--sd-float-edge:\s*#c99b51/, '主悬浮窗使用固定金色边线');
assert.match(css, /#story-director-float\s*\{[^}]*background:\s*rgba\(255, 255, 255, \.22\) !important/, '主悬浮窗必须使用固定半透明玻璃底');
assert.match(css, /#story-director-float::after\s*\{[^}]*background:\s*var\(--sd-float-edge\)[^}]*mask-composite:\s*exclude/, '主悬浮窗必须使用独立的不透明金色边框环');
assert.match(css, /#story-director-float\s*\{[^}]*backdrop-filter:\s*blur\(22px\) saturate\(1\.12\)/, '主悬浮窗必须直接采样页面背景形成毛玻璃');
const floatGlass = css.slice(css.indexOf('#story-director-float::before'), css.indexOf('#story-director-float:hover'));
assert.match(floatGlass, /sd-float-glass-breathe/, '主 Logo 透白底必须保留缓慢呼吸');
assert.match(css, /@keyframes sd-float-glass-breathe\s*\{[^}]*opacity:\s*\.34[\s\S]*opacity:\s*\.88/, '呼吸只改变玻璃辉光透明度，不能把底色遮成实色');
assert.doesNotMatch(css, /#story-director-float\.sd-theme-|#story-director-quick-wheel\.sd-theme-/, '悬浮窗与蜂巢不得再受面板主题配色影响');
assert.match(css, /\.is-glass-light\s*\{[^}]*rgba\(248, 247, 243, \.34\)[^}]*--sd-wheel-icon:\s*#4b4b49/, '浅玻璃必须搭配暗灰图标');
assert.match(css, /\.is-glass-dark\s*\{[^}]*rgba\(43, 44, 44, \.42\)[^}]*--sd-wheel-icon:\s*#f7f3ea/, '暗玻璃必须搭配白色图标');
assert.match(css, /\.is-edge-ivory\s*\{[^}]*#ddd8cd[\s\S]*\.is-edge-gold\s*\{[^}]*#c99b51[\s\S]*\.is-edge-graphite\s*\{[^}]*#77736d/, '边线仅使用浅灰、金和中灰细线');
assert.match(css, /\.sd-wheel-command\s*\{[^}]*padding:\s*1\.2px !important/, '蜂巢边线必须恢复原细线规格');
assert.match(css, /backdrop-filter:\s*blur\(20px\) saturate\(1\.12\) brightness\(1\.04\) !important/, '蜂巢需保留背景可见的高模糊毛玻璃');
assert.match(source, /setProperty\('backdrop-filter', 'blur\(20px\)[^\n]*'important'\)/, '蜂巢关键视觉属性必须以内联 important 隔离 ST 美化覆盖');
assert.match(css, /\.sd-wheel-command::after\s*\{[^}]*background:\s*var\(--sd-wheel-edge[^}]*mask-composite:\s*exclude/, '蜂巢边线必须作为独立环绘制，不能用不透明色垫满中心');
assert.match(css, /sd-wheel-hive-in[\s\S]*rotateY\(82deg\)/, '蜂巢片应有翻转入场效果');
assert.match(css, /\.sd-wheel-command\.is-external\s*\{[^}]*animation:\s*none[^}]*opacity:\s*1/, '第三方收纳片必须保持静态，边线仍沿用随机 Logo 色系');
assert.match(css, /\.sd-wheel-command\.is-undock-ready/, '拖出解除收纳必须提供清晰的就绪反馈');
assert.match(css, /\.sd-quick-docked-origin\s*\{[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none/, '原插件入口只能视觉隐藏，不能从 DOM 删除');
assert.match(css, /prefers-reduced-motion:\s*reduce/, '蜂巢动态必须尊重系统减少动态设置');

// 直接执行纯几何函数：居中先满六格内圈，贴边不移动锚点且所有蜂巢片留在可视区。
const geometryStart = source.indexOf('const QUICK_HEX_HEIGHT_RATIO');
const geometryEnd = source.indexOf('const quickDockRuntime');
assert.ok(geometryStart > 0 && geometryEnd > geometryStart, '未找到蜂巢纯几何实现');
const sandbox = {};
vm.runInNewContext(`${source.slice(geometryStart, geometryEnd)}\nglobalThis.hive = { QUICK_HEX_HEIGHT_RATIO, quickHiveAxialRing, quickHiveCellRing, quickHiveCellFits, quickHiveLayout };`, sandbox);
const { hive } = sandbox;
assert.equal(hive.QUICK_HEX_HEIGHT_RATIO, Math.sqrt(3) / 2);
const firstRing = hive.quickHiveAxialRing(1);
assert.equal(firstRing.length, 6);
assert.equal(new Set(firstRing.map(({ q, r }) => `${q},${r}`)).size, 6);
assert.ok(firstRing.every((cell) => hive.quickHiveCellRing(cell) === 1));
assert.equal(hive.quickHiveAxialRing(2).length, 12);
const centered = hive.quickHiveLayout(8, 50, { centerX: 200, centerY: 200, viewportWidth: 400, viewportHeight: 400, margin: 8 });
assert.equal(centered.edgeDirected, false);
assert.ok(centered.cells.slice(0, 6).every((cell) => hive.quickHiveCellRing(cell) === 1));
assert.ok(centered.cells.slice(6).every((cell) => hive.quickHiveCellRing(cell) === 2));
const expanded = hive.quickHiveLayout(24, 50, { centerX: 35, centerY: 40, viewportWidth: 390, viewportHeight: 800, margin: 8 });
assert.equal(expanded.cells.length, 24, '移动端角落必须容纳内部安全容量的完整蜂巢');
assert.ok(expanded.cells.every((cell) => hive.quickHiveCellFits(cell, expanded)));
const edgeCenter = { centerX: 35, centerY: 400, viewportWidth: 390, viewportHeight: 800, margin: 8 };
const atLeftEdge = hive.quickHiveLayout(8, 50, edgeCenter);
assert.equal(atLeftEdge.centerX, edgeCenter.centerX, '贴边布局不得移动主悬浮窗中心');
assert.equal(atLeftEdge.edgeDirected, true);
assert.equal(atLeftEdge.cells.length, 8);
assert.ok(atLeftEdge.cells.every((cell) => hive.quickHiveCellFits(cell, atLeftEdge)), '贴边蜂巢不得越出可视区');
for (const size of [32, 40, 50]) {
  const width = 390;
  const height = 800;
  const halfW = size / 2;
  const halfH = size * hive.QUICK_HEX_HEIGHT_RATIO / 2;
  const anchors = [
    [10 + halfW, height / 2], [width - 10 - halfW, height / 2],
    [width / 2, 10 + halfH], [width / 2, height - 10 - halfH],
    [10 + halfW, 10 + halfH], [width - 10 - halfW, 10 + halfH],
    [10 + halfW, height - 10 - halfH], [width - 10 - halfW, height - 10 - halfH],
  ];
  for (const [centerX, centerY] of anchors) {
    const layout = hive.quickHiveLayout(8, size, { centerX, centerY, viewportWidth: width, viewportHeight: height, margin: 8 });
    assert.equal(layout.centerX, centerX);
    assert.equal(layout.centerY, centerY);
    assert.equal(layout.cells.length, 8);
    assert.ok(layout.cells.every((cell) => hive.quickHiveCellFits(cell, layout)), `${size}px 贴边/角落蜂巢不得越界`);
  }
}

assert.match(css, /#story-director-floor-nav/);
assert.match(css, /#story-director-floor-nav\s*\{[^}]*overflow-y:\s*auto/);
assert.match(css, /\.sd-floor-shell\s*\{[^}]*min-height:\s*100%[^}]*display:\s*flex/);
assert.doesNotMatch(css, /#story-director-floor-nav \.sd-floor-panel\s*\{[^}]*max-height:\s*100%[^}]*overflow:\s*hidden/);
assert.match(css, /#story-director-floor-nav\.sd-theme-dark/);
assert.match(css, /\.mes\.sd-floor-jump-hit/);

// 楼层工具新增独立正文排版页：默认零介入，首次改值即启用，不提供额外启动开关。
assert.match(source, /const PROSE_LAYOUT_DEFAULTS[\s\S]*active:\s*false/);
for (const label of ['字号', '行高', '段距', '缩进', '宽度', '换行整理为段落', '两端对齐']) {
  assert.match(source, new RegExp(label));
}
assert.doesNotMatch(source.slice(source.indexOf('const PROSE_LAYOUT_CONTROLS'), source.indexOf('const PROSE_LAYOUT_STORAGE_KEY')), /sidePadding|边距/, '宽度与边距功能重叠，只保留宽度');
assert.match(source, /data-floor-tab="jump"[\s\S]*data-floor-tab="layout"/);
assert.match(source, /layout\[key\] = value;[\s\S]*layout\.active = true;/, '任一数值发生变化即应用正文排版');
assert.doesNotMatch(source, /data-prose-toggle="active"|启用正文排版/, '不得增加额外的启用开关');
assert.match(source, /settings\.proseLayout = clone\(PROSE_LAYOUT_DEFAULTS\)/, '必须可一键恢复 ST 原始正文排版');
assert.match(source, /PROSE_LAYOUT_STORAGE_KEY[\s\S]*readCachedProseLayout[\s\S]*cacheProseLayout/, '正文排版必须具有刷新防丢的本地持久化镜像');
assert.match(source, /function persistProseLayout[\s\S]*extensionSettings\[MODULE_NAME\]\.proseLayout = clone\(layout\)[\s\S]*saveSettingsDebounced/, '保存必须同时写回 ST 设置对象');
assert.match(source, /input\[type="number"\]\[data-prose-key\][\s\S]*addEventListener\('input'/, '数值输入必须即时响应');
assert.match(source, /querySelectorAll\('#chat \.mes_text'\)/, '排版功能必须严格限制在聊天正文');
assert.doesNotMatch(source.slice(source.indexOf('function proseLayoutMarkBreaks'), source.indexOf('function proseLayoutSchedule')), /innerHTML|outerHTML|wrap|replaceWith/, '换行整理不得重建正文或复制参考实现');
assert.match(css, /html body\.sd-prose-layout #chat \.mes \.mes_text[\s\S]*line-height:\s*var\(--sd-prose-line-height\) !important/, '正文排版必须以高优先级覆盖 ST 美化');
assert.match(css, /html body\.sd-prose-justify #chat \.mes \.mes_text/);
assert.match(css, /body\.sd-prose-split-breaks #chat \.mes \.mes_text \[data-sd-prose-gap="1"\][\s\S]*height:\s*var\(--sd-prose-paragraph-gap\) !important/, '段距必须使用稳定的间隔元素而非无效的 br margin');
assert.match(css, /\.sd-floor-search\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto/);
assert.match(css, /\.sd-floor-actions\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
assert.match(css, /\.sd-floor-jump\s*\{[^}]*border-radius:\s*999px/);
assert.match(css, /\.sd-floor-actions button\s*\{[^}]*border-radius:\s*999px/);

console.log('Quick wheel and floor jump contract OK');
