import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.match(source, /floatSize: null/, '旧用户必须保留桌面48/移动44的响应式默认值');
assert.match(source, /const FLOAT_SIZE_MIN = 32;[\s\S]*const FLOAT_SIZE_MAX = 80;/, '悬浮球尺寸范围必须集中使用32至80像素');
assert.match(source, /function getFloatSize\(\)[\s\S]*Math\.max\(FLOAT_SIZE_MIN, Math\.min\(FLOAT_SIZE_MAX, configured\)\)/, '已保存的悬浮球尺寸必须限制在32至80像素');
assert.match(source, /class="sd-float-size"[^>]*min="\$\{FLOAT_SIZE_MIN\}" max="\$\{FLOAT_SIZE_MAX\}"/, '尺寸滑块最大值必须使用80像素上限');
assert.match(source, /requestedSize = Math\.max\(FLOAT_SIZE_MIN, Math\.min\(FLOAT_SIZE_MAX, Math\.round\(floatSize\)\)\)/, '蜂巢展开尺寸必须与悬浮球共用80像素上限');
assert.match(source, /btn\.style\.width = `\$\{pos\.size\}px`[\s\S]*btn\.style\.height/, '实际悬浮球宽高必须使用尺寸真源');
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

console.log('Floating button size contract OK');
