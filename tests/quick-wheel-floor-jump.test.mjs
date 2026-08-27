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
for (const id of ['dashboard', 'focus', 'tasksnodes', 'castworld', 'context', 'settings', 'theater', 'tts', 'coread', 'geopolitics', 'plug', 'imagegen', 'floor']) {
  assert.match(source, new RegExp(`id: '${id}'`));
}
const quickCommands = source.slice(source.indexOf('const QUICK_COMMANDS'), source.indexOf('const QUICK_COMMAND_IDS'));
assert.doesNotMatch(quickCommands, /id: 'blueprint'/, '编剧已并入幕后，不得继续占用蜂巢入口');
assert.match(quickCommands, /id: 'settings', label: '幕后', icon: 'fa-feather-pointed'/, '幕后蜂巢入口必须改用羽毛笔');
assert.match(source, /QUICK_HIVE_SAFETY_LIMIT = 24/, '仅保留异常配置安全阀，不得再把八格当作产品限制');
assert.doesNotMatch(source, /QUICK_HIVE_MAX_ITEMS|最多显示 \$\{QUICK_HIVE/, '设置页不得再显示蜂巢入口上限');
assert.match(source, /function quickHiveAxialRing[\s\S]*function quickHiveLayout/, '蜂巢必须使用通用轴向六角坐标生成器');
assert.doesNotMatch(source, /<option value="default"[^>]*>默认方案<\/option>/, '不得再显示固定默认方案');
assert.match(source, /const iconMarkup = item\.external \? quickDockIconMarkup\(item\)/, '第三方 Logo 必须经过安全视觉描述渲染');
assert.match(source, /button\.innerHTML = `\$\{iconMarkup\}\$\{QUICK_HEX_BORDER_SVG\}`/, '每个蜂巢片必须挂载独立六边形描边');
assert.match(source, /const FLOAT_LOGO_URLS = Object\.freeze\([\s\S]*qianmulogo-dark\.png[\s\S]*qianmulogo-summer\.png[\s\S]*qianmulogo-candy\.png[\s\S]*qianmulogo-dream\.png/, '四套新增外观必须使用各自正式 Logo');
assert.match(source, /btn\.innerHTML = `<img src="\$\{logoUrl\}"/, '正式 Logo 必须按当前外观挂载到真实悬浮窗');
assert.doesNotMatch(source, /sd-wheel-core/, '展开时不得再创建会使锚点跳位的替代中心按钮');
assert.match(source, /const QUICK_HIVE_THEME_PALETTES = Object\.freeze\([\s\S]*dark:[\s\S]*summer:[\s\S]*candy:[\s\S]*kraft:[\s\S]*dream:/, '蜂巢边线与主 Logo 必须按六套面板外观建立视觉方案');
assert.match(source, /lightFill:[^\n]*darkFill:[\s\S]*edges:/, '主题只改变灰白玻璃的明暗与边线，不得把玻璃底染成强调色');
assert.match(source, /root\.className = `sd-wheel-hive sd-hive-theme-\$\{themeKey\}/, '展开蜂巢必须标记当前面板外观');
const renderFloat = source.slice(source.indexOf('function renderFloatButton'), source.indexOf('function renderBusyState'));
assert.match(renderFloat, /FLOAT_LOGO_URLS\[themeKey\][\s\S]*sd-hive-theme-\$\{themeKey\}[\s\S]*palette\.mainEdge/, '主悬浮窗必须同步 Logo、边线与灰白玻璃明暗');
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
assert.match(source, /function quickDockCleanLabel[\s\S]*第三方[\s\S]*function quickDockNextFallbackLabel[\s\S]*插件收纳\$\{index\}/, '第三方通用名称必须替换为稳定编号占位');
assert.match(source, /function quickDockExtensionApi[\s\S]*import\('\.\.\/\.\.\/\.\.\/extensions\.js'\)[\s\S]*getExtensionManifest/, '蜂巢应优先从 ST 扩展清单读取真实插件名称');
assert.match(source, /function quickDockResolvePluginLabel[\s\S]*manifest\?\.display_name[\s\S]*function quickDockApplyResolvedLabel/, '识别到扩展归属后必须用 manifest 名称替换编号占位');
assert.match(source, /document\.addEventListener\('pointerdown', quickDockOnPointerDown, true\)/);
assert.match(source, /drag\.moved && drag\.ready[\s\S]*quickDockAttach\(drag\.host, drag\.activator\)/);
assert.match(source, /host\.classList\.add\('sd-quick-docked-origin'\)|classList\.toggle\('sd-quick-docked-origin'/);
assert.match(source, /function quickDockDispatchActivation[\s\S]*requestAnimationFrame[\s\S]*KeyboardEvent\('keydown'[\s\S]*KeyboardEvent\('keyup'[\s\S]*pointerdown[\s\S]*mousedown[\s\S]*pointerup[\s\S]*mouseup/, '代理蜂巢片须按 role=button 键盘语义或自定义指针序列唤起');
assert.match(source, /function quickDockRun[\s\S]*quickDockDispatchActivation\(record\)/, '第三方代理入口必须统一走兼容唤起通道');
const dockAttach = source.slice(source.indexOf('function quickDockAttach'), source.indexOf('function quickDockRemove'));
assert.doesNotMatch(dockAttach, /appendChild|replaceChild|insertBefore/, '收纳不得移动或重挂第三方插件 DOM');
const wheelSettings = source.slice(source.indexOf('function renderQuickWheelSettings'), source.indexOf('function renderPlugTab'));
assert.doesNotMatch(wheelSettings, /sd-wheel-docked-list|已收纳悬浮窗|sd-wheel-dock-remove/, '编辑蜂巢入口只管理千幕入口，第三方悬浮窗仅通过拖入拖出管理');
assert.doesNotMatch(wheelSettings, /可自由组合千幕全部入口|拖动其他插件的悬浮窗靠近千幕/, '蜂巢入口编辑区不得保留上下两段说明小字');

// 短按仍开主面板，长按才开轮盘；半隐藏触屏长按必须先冻结滑出动画再读取最终锚点。
assert.match(source, /function openQuickWheelFromLongPress[\s\S]*sd-float-wheel-opening[\s\S]*revealFloatButton[\s\S]*getBoundingClientRect[\s\S]*openQuickWheel\(btn\)/);
assert.match(source, /setTimeout\(\(\) =>[\s\S]*?openQuickWheelFromLongPress\(btn\)[\s\S]*?300\)/);
assert.match(source, /if \(wheelOpened\) return;[\s\S]*event\.pointerType === 'touch' \? 12 : 4/, '长按确认后须锁住主格，触屏抖动阈值应宽于鼠标');
assert.doesNotMatch(source, /if \(wheelOpened\) closeQuickWheel\(\)/, '长按后的自然手指抖动不得关闭轮盘');
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
assert.match(css, /#story-director-float\.sd-float-wheel-opening\s*\{[^}]*transition:\s*none !important/, '读取触屏长按锚点前必须冻结主格位移动画');
assert.match(css, /--sd-wheel-item-height/);
assert.match(css, /clip-path:\s*polygon\(50% 0, 100% 25%, 100% 75%/, '蜂巢入口必须是左右直边的竖向正六边形');
assert.match(source, /mainEdge: '#c99b51'[\s\S]*mainEdge: '#8faf9b'[\s\S]*mainEdge: '#9fca62'[\s\S]*mainEdge: '#e3a0b8'/, '主 Logo 边线必须覆盖日间、夜间、柠夏与粉糯的指定强调色');
assert.match(source, /kraft:[\s\S]*mainEdge: '#c99b51'/, '旧笺主 Logo 必须沿用金色边线');
assert.match(css, /#story-director-float\.sd-hive-theme-dream[^}]*animation:\s*sd-hive-dream-edge 12s/, '幻梦主 Logo 边线必须缓慢虹彩变化');
assert.match(source, /QUICK_HEX_BORDER_SVG[\s\S]*<polygon points="43\.301,0 86\.602,25 86\.602,75 43\.301,100 0,75 0,25"/, '主悬浮窗与蜂巢片必须使用左右直边的真实六边形矢量描边');
assert.match(css, /#story-director-float\s*\{[^}]*backdrop-filter:\s*blur\(22px\) saturate\(1\.12\)/, '主悬浮窗必须直接采样页面背景形成毛玻璃');
const floatGlass = css.slice(css.indexOf('#story-director-float::before'), css.indexOf('#story-director-float:hover'));
assert.match(floatGlass, /sd-float-glass-breathe/, '主 Logo 透白底必须保留缓慢呼吸');
assert.match(css, /@keyframes sd-float-glass-breathe\s*\{[^}]*opacity:\s*\.34[\s\S]*opacity:\s*\.88/, '呼吸只改变玻璃辉光透明度，不能把底色遮成实色');
assert.match(source, /const darkGlass = Math\.random\(\) >= \.5[\s\S]*palette\.darkFill : palette\.lightFill[\s\S]*palette\.edges/, '蜂巢片必须从主题的灰白玻璃与边线组合中随机取样');
assert.match(css, /\.sd-wheel-command\s*\{[^}]*padding:\s*1\.2px !important/, '蜂巢边线必须恢复原细线规格');
assert.match(css, /backdrop-filter:\s*blur\(20px\) saturate\(1\.12\) brightness\(1\.04\) !important/, '蜂巢需保留背景可见的高模糊毛玻璃');
assert.match(source, /setProperty\('backdrop-filter', 'blur\(20px\)[^\n]*'important'\)/, '蜂巢关键视觉属性必须以内联 important 隔离 ST 美化覆盖');
assert.match(css, /\.sd-hive-hex-outline polygon\s*\{[^}]*stroke:\s*var\(--sd-wheel-edge[^}]*stroke-width:\s*1\.2px/, '蜂巢边线必须沿六边形路径使用原细线宽度描绘');
assert.doesNotMatch(css, /mask-composite:\s*exclude/, '不得再使用会把六边形描成横向残线的矩形遮罩');
assert.match(css, /sd-wheel-hive-in[\s\S]*rotateY\(82deg\)/, '蜂巢片应有翻转入场效果');
assert.match(css, /\.sd-wheel-command\.is-external\s*\{[^}]*animation:\s*none[^}]*opacity:\s*1/, '第三方收纳片必须保持静态，边线仍沿用随机 Logo 色系');
assert.match(css, /\.sd-wheel-command\.is-undock-ready/, '拖出解除收纳必须提供清晰的就绪反馈');
assert.match(css, /\.sd-quick-docked-origin\s*\{[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none/, '原插件入口只能视觉隐藏，不能从 DOM 删除');
assert.match(css, /\.sd-quick-docked-activating\s*\{[^}]*visibility:\s*visible/, '代理点击期间必须短暂恢复第三方入口的可交互布局状态');
assert.match(source, /function quickDockCandidate\(event\)[\s\S]*event\?\.composedPath/, '第三方拖入必须从 composedPath 识别 Shadow DOM 内真实入口');
assert.match(source, /function quickDockStablePath[\s\S]*getRootNode[\s\S]*ShadowRoot[\s\S]*function quickDockResolvePath[\s\S]*shadowRoot/, 'open Shadow DOM 入口必须保存并恢复逐层路径');
assert.match(source, /function quickDockSetOriginState[\s\S]*setProperty\('visibility', 'hidden', 'important'\)/, 'Shadow DOM 内原入口须以内联 important 可逆隐藏');
assert.match(source, /function quickDockObserveShadowRoots[\s\S]*observer\.observe\(root/, '恢复监听必须覆盖已存在的 open Shadow Root');
assert.match(source, /setInterval\(\(\) =>[\s\S]*quickDockScanStored\(\)/, 'Shadow Root 延迟建立必须有有限时长的低频恢复重试');
assert.match(source, /const gap = Math\.max\(1, Math\.min\(3, Math\.round\(itemHeight \* \.045\)\)\)/, '蜂巢间距必须缩至紧凑的一至三像素');
assert.match(source, /QUICK_ICON_OPTICAL_SCALE[\s\S]*tts:\s*1\.16/, '话筒等视觉偏小图标必须进行光学校正');
assert.match(css, /font-size:\s*clamp\(15px,[^;]*\.44[^;]*22px\)/, '千幕内置入口图标必须整体增大');
assert.match(css, /prefers-reduced-motion:\s*reduce/, '蜂巢动态必须尊重系统减少动态设置');

// 直接执行纯几何函数：居中先满六格内圈，贴边不移动锚点且所有蜂巢片留在可视区。
const geometryStart = source.indexOf('const QUICK_HEX_WIDTH_RATIO');
const geometryEnd = source.indexOf('const quickDockRuntime');
assert.ok(geometryStart > 0 && geometryEnd > geometryStart, '未找到蜂巢纯几何实现');
const sandbox = {};
vm.runInNewContext(`${source.slice(geometryStart, geometryEnd)}\nglobalThis.hive = { QUICK_HEX_WIDTH_RATIO, quickHiveAxialRing, quickHiveCellRing, quickHiveCellFits, quickHiveLayout };`, sandbox);
const { hive } = sandbox;
assert.equal(hive.QUICK_HEX_WIDTH_RATIO, Math.sqrt(3) / 2);
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
const halfHiddenLeft = hive.quickHiveLayout(8, 48, { centerX: 0, centerY: 400, viewportWidth: 390, viewportHeight: 800, margin: 4 });
assert.equal(halfHiddenLeft.cells.length, 8, '主 Logo 隐藏一半时仍须容纳完整快捷蜂巢');
assert.ok(halfHiddenLeft.cells.every((cell) => hive.quickHiveCellFits(cell, halfHiddenLeft)), '主 Logo 隐藏一半时蜂巢入口不得越出视口');
for (const size of [32, 40, 50]) {
  const width = 390;
  const height = 800;
  const halfW = size * hive.QUICK_HEX_WIDTH_RATIO / 2;
  const halfH = size / 2;
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

// 楼层工具新增独立正文排版页：默认零介入，三项开关置于滑动条组上方。
assert.match(source, /const PROSE_LAYOUT_DEFAULTS[\s\S]*active:\s*false/);
for (const label of ['开启排版', '字号', '行高', '段距', '缩进', '宽度', '换行整理为段落', '两端对齐']) {
  assert.match(source, new RegExp(label));
}
assert.doesNotMatch(source.slice(source.indexOf('const PROSE_LAYOUT_CONTROLS'), source.indexOf('const PROSE_LAYOUT_STORAGE_KEY')), /sidePadding|边距/, '宽度与边距功能重叠，只保留宽度');
assert.match(source, /data-floor-tab="jump"[\s\S]*data-floor-tab="layout"/);
assert.match(source, /data-prose-toggle="active"[\s\S]*开启排版/);
assert.doesNotMatch(source, /已应用正文排版|跟随 SillyTavern 默认|恢复正文默认/);
assert.ok(source.indexOf('data-prose-toggle="active"') < source.indexOf('<div class="sd-prose-controls">'), '排版开关组必须位于滑动条组上方');
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
