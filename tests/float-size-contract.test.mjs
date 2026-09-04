import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.match(source, /floatSize: null/, '旧用户必须保留桌面48/移动44的响应式默认值');
assert.match(source, /const FLOAT_SIZE_MIN = 32;[\s\S]*const FLOAT_SIZE_MAX = 80;/, '悬浮球尺寸范围必须集中使用32至80像素');
assert.match(source, /function getFloatSize\(\)[\s\S]*Math\.max\(FLOAT_SIZE_MIN, Math\.min\(FLOAT_SIZE_MAX, configured\)\)/, '已保存的悬浮球尺寸必须限制在32至80像素');
assert.match(source, /class="sd-float-size"[^>]*min="\$\{FLOAT_SIZE_MIN\}" max="\$\{FLOAT_SIZE_MAX\}"/, '尺寸滑块最大值必须使用80像素上限');
assert.match(source, /requestedSize = Math\.max\(FLOAT_SIZE_MIN, Math\.min\(FLOAT_SIZE_MAX, Math\.round\(floatSize\)\)\)/, '蜂巢展开尺寸必须与悬浮球共用80像素上限');
assert.match(source, /const width = `\$\{pos\.size\}px`;[\s\S]*const height = `\$\{pos\.height\}px`;/, '实际悬浮球宽高必须使用尺寸真源');
assert.match(source, /const minX = viewport\.left - width \/ 2;[\s\S]*const maxX = Math\.max\(minX, viewport\.right - width \/ 2\)/, '主 Logo 可主动半隐藏，但任何视口下必须至少保留半格可拖区域');
assert.match(source, /if \(hiddenX && hiddenY\)[\s\S]*xDepth[\s\S]*yDepth/, '角落位置只能隐藏一条边，主 Logo 的可见面积不得少于一半');
assert.match(source, /Number\.isFinite\(rawX\)[\s\S]*Number\.isFinite\(rawY\)/, '损坏或漂移产生的非有限坐标必须恢复为安全默认位置');
assert.match(source, /#top-settings-holder[\s\S]*spansHeader[\s\S]*safeTop/, '顶部安全区必须识别 ST 横向顶栏且忽略纵向侧栏主题');
assert.match(source, /viewportChanged[\s\S]*ratioX[\s\S]*ratioY[\s\S]*settings\.floatPosition\.viewportWidth/, 'PC 与移动端切换时必须按相对方位重算坐标');
assert.match(source, /style\.setProperty\('width', width, 'important'\)[\s\S]*style\.setProperty\('max-width', width, 'important'\)[\s\S]*style\.setProperty\('height', height, 'important'\)/, '悬浮入口宽高必须抵抗第三方主题的按钮全宽样式');
assert.match(source, /function startFloatHostGuard[\s\S]*MutationObserver[\s\S]*childList: true/, '悬浮入口被宿主重建误删后必须用轻量直属观察恢复');
assert.match(source, /function revealFloatButton[\s\S]*sd-float-revealed[\s\S]*function bindFloatDrag[\s\S]*pointerenter[\s\S]*revealFloatButton/, '桌面悬停半隐藏 Logo 时必须滑出完整');
assert.match(source, /if \(!btn\.classList\.contains\('sd-float-revealed'\) && revealFloatButton\(btn\)\)/, '触屏第一次点半隐藏 Logo 只滑出完整，不得直接打开面板');
assert.match(css, /#story-director-float\.sd-float-dragging\s*\{[^}]*transition:\s*none/, '拖动 Logo 时必须关闭位置缓动，保持跟手');
assert.match(source, /sd-float-size-control[\s\S]*settings\.floatingButton \? '' : 'hidden'/, '尺寸滑块必须跟随显示悬浮球勾选状态');
assert.match(source, /sd-float-size[^]*addEventListener\('input'[^]*renderFloatButton\(\)/, '拖动尺寸滑块必须实时刷新悬浮球');
assert.match(source, /sd-float-size[^]*addEventListener\('change', \(\) => saveSettings\(\)\)/, '最终尺寸必须持久化');
assert.match(css, /\.sd-float-size-control\[hidden\][^}]*display: none !important/, '关闭悬浮球时尺寸面板必须真正隐藏');
const apiCard = source.slice(source.indexOf('<h3>API</h3>'), source.indexOf('<h3>小组件</h3>'));
assert.match(apiCard, /sd-api-generation-row[\s\S]*温度[\s\S]*最大输出[\s\S]*上下文长度/, '三个简化标题的生成参数必须收进同一排');
assert.doesNotMatch(apiCard, /Temperature|最大输出 token/);
assert.match(apiCard, /sd-api-action-row[\s\S]*sd-save-api[\s\S]*sd-save-api-profile[\s\S]*sd-test-api[\s\S]*sd-stream-toggle[\s\S]*>流式传输<\/button>[\s\S]*sd-stream-scope-hint">仅支持自定义<\/small>/, '保存操作须在第一排，测试与流式传输依次位于第二排');
assert.doesNotMatch(apiCard, /仅支持自定义API/);
assert.match(source, /<section class="sd-card sd-widget-card">\s*<h3>小组件<\/h3>[\s\S]*data-widget-toggle="floating"[\s\S]*data-widget-toggle="notes"[\s\S]*data-widget-toggle="wheel"[\s\S]*data-widget-toggle="dock"[\s\S]*sd-float-size-control[\s\S]*renderQuickWheelSettings/, '小组件卡必须以标签态统一管理悬浮球、便笺、快捷盘和蜂巢收纳');
assert.match(css, /\.sd-api-generation-row\s*\{[^}]*grid-template-columns:\s*repeat\(3/, '三个生成参数必须三列同排');
assert.match(css, /\.sd-api-action-row\s*\{[^}]*grid-template-columns:\s*repeat\(2/, 'API四项操作必须两列等宽、固定两排');
assert.match(css, /\.sd-api-stream-action\s*\{[^}]*display:\s*grid[^}]*gap:\s*4px/, '流式说明必须稳定显示在按钮下方');

const floatStart = source.indexOf('function getFloatSize()');
const floatEnd = source.indexOf('const QUICK_COMMANDS');
class FakeElement {
  constructor(rect) { this.rect = rect; }
  getBoundingClientRect() { return this.rect; }
}
const topBars = [];
const sandbox = {
  settings: { floatSize: 48, floatPosition: { x: -100, y: -100 } },
  window: { innerWidth: 400, innerHeight: 800, matchMedia: () => ({ matches: false }) },
  document: { getElementById: () => null, querySelectorAll: () => topBars },
  getComputedStyle: () => ({ display: 'flex', visibility: 'visible' }),
  Element: FakeElement,
  QUICK_HEX_WIDTH_RATIO: Math.sqrt(3) / 2,
  FLOAT_SIZE_MIN: 32,
  FLOAT_SIZE_MAX: 80,
  QUICK_WHEEL_ID: 'test-wheel',
  clearTimeout,
  setTimeout,
};
vm.runInNewContext(`${source.slice(floatStart, floatEnd)}\nglobalThis.floatContract = { clampFloatPosition };`, sandbox);
const halfHidden = sandbox.floatContract.clampFloatPosition();
assert.equal(halfHidden.x, -(48 * Math.sqrt(3) / 2) / 2, '左边最多隐藏半个 Logo');
assert.equal(halfHidden.y, 4, '顶部不得半隐藏或落入 ST 顶栏，左上角仍须保留完整拖动面');
assert.equal(halfHidden.height, 48, '位置结果中的 height 必须保持悬浮格高度，不能被视口高度覆盖');
assert.equal(halfHidden.viewportHeight, 800, '视口高度必须使用独立字段返回');
assert.notEqual(halfHidden.height, halfHidden.viewportHeight, '悬浮格高度与视口高度不得再发生字段碰撞');
sandbox.settings.floatPosition = { x: 399, y: 300 };
const rightHidden = sandbox.floatContract.clampFloatPosition();
assert.equal(rightHidden.x, 400 - (48 * Math.sqrt(3) / 2) / 2, '右边最多隐藏半个 Logo');
assert.equal(rightHidden.y, 300);
sandbox.settings.floatPosition = { x: Number.NaN, y: Number.POSITIVE_INFINITY };
const repaired = sandbox.floatContract.clampFloatPosition();
assert.equal(Number.isFinite(repaired.x), true, 'NaN 横坐标必须修回可见区域');
assert.equal(Number.isFinite(repaired.y), true, 'Infinity 纵坐标必须修回可见区域');
assert.ok(repaired.y >= repaired.minY, '修复后的坐标不得位于顶部安全区之外');
sandbox.settings.floatPosition = { x: null, y: null };
const initial = sandbox.floatContract.clampFloatPosition();
assert.ok(initial.x > 300 && initial.y > 600, '首次安装的空坐标必须落在右下安全默认位，不能被 Number(null) 推到左上角');
topBars.push(new FakeElement({ left: 0, right: 400, top: 0, bottom: 52, width: 400, height: 52 }));
sandbox.settings.floatPosition = { x: 8, y: 0 };
const belowToolbar = sandbox.floatContract.clampFloatPosition();
assert.equal(belowToolbar.y, 56, '保存坐标落入 ST 顶栏时必须迁回顶栏下方安全区');

sandbox.settings.floatPosition = { ...sandbox.settings.floatPosition, ratioX: 1, ratioY: .5, viewportWidth: 400, viewportHeight: 800 };
sandbox.window.innerWidth = 260;
sandbox.window.innerHeight = 520;
const mobileMapped = sandbox.floatContract.clampFloatPosition();
assert.equal(mobileMapped.x, mobileMapped.maxX, '切到窄屏时右侧方位必须保持并至少留下半格可见');
assert.ok(mobileMapped.y >= mobileMapped.minY && mobileMapped.y <= mobileMapped.maxY, '切到窄屏后的纵坐标必须保持可操作');

console.log('Floating button size contract OK');
