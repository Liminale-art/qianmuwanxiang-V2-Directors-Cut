import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

const helperStart = source.indexOf('function nestedScrollAtBoundary');
const helperEnd = source.indexOf('function bindPanelScrollStability');
assert.ok(helperStart > 0 && helperEnd > helperStart, '必须提供可独立验证的嵌套滚动边界判断');

class FakeElement {}
const sandbox = { Element: FakeElement, Number, Math };
vm.runInNewContext(`${source.slice(helperStart, helperEnd)}\nglobalThis.atBoundary = nestedScrollAtBoundary;`, sandbox);
const atBoundary = sandbox.atBoundary;
const el = Object.assign(new FakeElement(), { scrollTop: 0, scrollHeight: 600, clientHeight: 200 });
assert.equal(atBoundary(el, -20), true, '文本框顶部继续向上时应交给主面板');
assert.equal(atBoundary(el, 20), false, '文本框顶部向下时仍应滚动文本框本身');
el.scrollTop = 180;
assert.equal(atBoundary(el, -20), false);
assert.equal(atBoundary(el, 20), false, '文本框中段不得劫持原生滚动');
el.scrollTop = 400;
assert.equal(atBoundary(el, 20), true, '文本框底部继续向下时应交给主面板');
el.scrollHeight = 180;
el.clientHeight = 200;
el.scrollTop = 0;
assert.equal(atBoundary(el, 20), true, '不可内部滚动的文本框应直接交给主面板');

const bindStart = helperEnd;
const bindEnd = source.indexOf('function bindActiveTabEvents', bindStart);
const binding = source.slice(bindStart, bindEnd);
assert.match(binding, /textarea\.sd-textarea[\s\S]*addEventListener\('wheel'[\s\S]*passive: false/);
assert.match(binding, /addEventListener\('touchmove'[\s\S]*nestedScrollAtBoundary[\s\S]*body\.scrollTop \+= deltaY[\s\S]*passive: false/);
assert.match(binding, /details\[data-acc\][\s\S]*requestAnimationFrame\(\(\) => requestAnimationFrame/, '折叠高度变化后须在布局稳定帧校准滚动锚点');
assert.match(source, /bindPanelScrollStability\(root\);[\s\S]*bindTheaterTabEvents\(root\)/, '共享稳定器必须覆盖所有普通 tab，而非只补幕后单卡');
assert.match(css, /#story-director-modal \.sd-textarea\s*\{[^}]*overscroll-behavior-y:\s*auto !important[^}]*touch-action:\s*pan-y !important/);

console.log('Panel nested-scroll and details-anchor stability contract OK');
