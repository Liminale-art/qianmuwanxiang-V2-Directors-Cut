import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.match(source, /floatSize: null/, '旧用户必须保留桌面48/移动44的响应式默认值');
assert.match(source, /function getFloatSize\(\)[\s\S]*Math\.max\(32, Math\.min\(50, configured\)\)/, '悬浮球尺寸必须限制在32至50像素');
assert.match(source, /class="sd-float-size"[^>]*min="32" max="50"/, '尺寸滑块最大值必须为50像素');
assert.match(source, /btn\.style\.width = `\$\{pos\.size\}px`[\s\S]*btn\.style\.height/, '实际悬浮球宽高必须使用尺寸真源');
assert.match(source, /sd-float-size-control[\s\S]*settings\.floatingButton \? '' : 'hidden'/, '尺寸滑块必须跟随显示悬浮球勾选状态');
assert.match(source, /sd-float-size[^]*addEventListener\('input'[^]*renderFloatButton\(\)/, '拖动尺寸滑块必须实时刷新悬浮球');
assert.match(source, /sd-float-size[^]*addEventListener\('change', \(\) => saveSettings\(\)\)/, '最终尺寸必须持久化');
assert.match(css, /\.sd-float-size-control\[hidden\][^}]*display: none !important/, '关闭悬浮球时尺寸面板必须真正隐藏');
assert.match(source, /class="sd-stream-setting"[\s\S]*sd-stream-toggle[\s\S]*sd-stream-scope-hint">仅支持自定义API<\/p>[\s\S]*<\/div>[\s\S]*sd-float-toggle/, '流式支持范围说明必须紧贴流式传输开关，而不是悬浮球设置');
assert.match(css, /\.sd-stream-setting[^}]*flex-direction: column/, '流式支持范围说明必须稳定显示在开关下方');

console.log('Floating button size contract OK');
