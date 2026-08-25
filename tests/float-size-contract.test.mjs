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
assert.match(source, /btn\.style\.width = `\$\{pos\.size\}px`[\s\S]*btn\.style\.height/, '实际悬浮球宽高必须使用尺寸真源');
assert.match(source, /const minX = -width \/ 2;[\s\S]*const minY = -height \/ 2;/, '主 Logo 可由用户手动拖到四边并最多隐藏一半');
assert.match(source, /if \(hiddenX && hiddenY\)[\s\S]*xDepth[\s\S]*yDepth/, '角落位置只能隐藏一条边，主 Logo 的可见面积不得少于一半');
assert.match(source, /function revealFloatButton[\s\S]*sd-float-revealed[\s\S]*function bindFloatDrag[\s\S]*pointerenter[\s\S]*revealFloatButton/, '桌面悬停半隐藏 Logo 时必须滑出完整');
assert.match(source, /if \(!btn\.classList\.contains\('sd-float-revealed'\) && revealFloatButton\(btn\)\)/, '触屏第一次点半隐藏 Logo 只滑出完整，不得直接打开面板');
assert.match(css, /#story-director-float\.sd-float-dragging\s*\{[^}]*transition:\s*none/, '拖动 Logo 时必须关闭位置缓动，保持跟手');
assert.match(source, /sd-float-size-control[\s\S]*settings\.floatingButton \? '' : 'hidden'/, '尺寸滑块必须跟随显示悬浮球勾选状态');
assert.match(source, /sd-float-size[^]*addEventListener\('input'[^]*renderFloatButton\(\)/, '拖动尺寸滑块必须实时刷新悬浮球');
assert.match(source, /sd-float-size[^]*addEventListener\('change', \(\) => saveSettings\(\)\)/, '最终尺寸必须持久化');
assert.match(css, /\.sd-float-size-control\[hidden\][^}]*display: none !important/, '关闭悬浮球时尺寸面板必须真正隐藏');
const apiCard = source.slice(source.indexOf('<h3>API</h3>'), source.indexOf('<h3>悬浮球设置</h3>'));
assert.match(apiCard, /sd-api-generation-row[\s\S]*温度[\s\S]*最大输出[\s\S]*上下文长度/, '三个简化标题的生成参数必须收进同一排');
assert.doesNotMatch(apiCard, /Temperature|最大输出 token/);
assert.match(apiCard, /sd-api-action-row[\s\S]*sd-save-api[\s\S]*sd-save-api-profile[\s\S]*sd-test-api[\s\S]*sd-stream-toggle[\s\S]*>流式传输<\/button>[\s\S]*sd-stream-scope-hint">仅支持自定义<\/small>/, '保存操作须在第一排，测试与流式传输依次位于第二排');
assert.doesNotMatch(apiCard, /仅支持自定义API/);
assert.match(source, /<section class="sd-card">\s*<h3>悬浮球设置<\/h3>[\s\S]*sd-float-toggle[\s\S]*sd-float-size-control[\s\S]*renderQuickWheelSettings/, '悬浮球与蜂巢设置必须独立成卡');
assert.match(css, /\.sd-api-generation-row\s*\{[^}]*grid-template-columns:\s*repeat\(3/, '三个生成参数必须三列同排');
assert.match(css, /\.sd-api-action-row\s*\{[^}]*grid-template-columns:\s*repeat\(2/, 'API四项操作必须两列等宽、固定两排');
assert.match(css, /\.sd-api-stream-action\s*\{[^}]*display:\s*grid[^}]*gap:\s*4px/, '流式说明必须稳定显示在按钮下方');

const floatStart = source.indexOf('function getFloatSize()');
const floatEnd = source.indexOf('const QUICK_COMMANDS');
const sandbox = {
  settings: { floatSize: 48, floatPosition: { x: -100, y: -100 } },
  window: { innerWidth: 400, innerHeight: 800, matchMedia: () => ({ matches: false }) },
  document: { getElementById: () => null },
  Element: class {},
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
assert.equal(halfHidden.y, 0, '落在角落时另一轴必须完整可见，不能只剩四分之一 Logo');
sandbox.settings.floatPosition = { x: 399, y: 300 };
const rightHidden = sandbox.floatContract.clampFloatPosition();
assert.equal(rightHidden.x, 400 - (48 * Math.sqrt(3) / 2) / 2, '右边最多隐藏半个 Logo');
assert.equal(rightHidden.y, 300);

console.log('Floating button size contract OK');
