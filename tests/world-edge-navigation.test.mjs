import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { qianmuIconMarkup, LUCIDE_STROKE_WIDTH, LUCIDE_ICON_MARKUP } from '../qianmu-icon-renderer.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const start = source.indexOf('function bindWorldFlipEvents(');
const fn = source.slice(start, source.indexOf('\n}', start) + 2);
const handlers = {}, buttons = [];
const shell = { isConnected: true, addEventListener: (type, cb) => { handlers[type] = cb; } };
const body = { scrollTop: 180 };
const root = { querySelector: (s) => s === '.sd-body' ? body : shell, querySelectorAll: () => [{ addEventListener: (_t, cb) => buttons.push(cb) }] };
let renders = 0, selectedText = '';
const sandbox = vm.createContext({ activeTab: 'castworld', worldPage: 'front', worldPageScrolls: new Map(), settings: { geopoliticsEnabled: true }, getChatKey: () => 'chatA', getSelection: () => ({ toString: () => selectedText }), renderModal: () => { renders++; body.scrollTop = 0; }, toast() {} });
vm.runInContext(fn, sandbox);
sandbox.bindWorldFlipEvents(root);
buttons[0]();
assert.equal(sandbox.worldPage, 'geopolitics');
assert.equal(body.scrollTop, 0);
body.scrollTop = 95;
buttons[0]();
assert.equal(sandbox.worldPage, 'front');
assert.equal(body.scrollTop, 180);
const event = (x, y, extra = {}) => ({ pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, timeStamp: 100, target: { closest: () => null }, ...extra });
const swipe = (extra = {}) => { handlers.pointerdown(event(40, 40, extra)); handlers.pointermove(event(100, 42, extra)); handlers.pointerup(event(100, 42, { timeStamp: 300, ...extra })); };
swipe();
assert.equal(renders, 3, 'horizontal touch flips');
swipe({ pointerType: 'mouse' });
swipe({ isPrimary: false });
swipe({ target: { closest: () => ({}) } });
selectedText = '正在选择的文字'; swipe(); selectedText = '';
assert.equal(renders, 3, 'mouse selection, secondary touches and controls do not flip');
handlers.pointerdown(event(40, 40));
handlers.pointermove(event(44, 70));
handlers.pointermove(event(140, 73));
handlers.pointerup(event(140, 73, { timeStamp: 300 }));
assert.equal(renders, 3, 'vertical scrolling locks out a later sideways drift');
handlers.pointerdown(event(40, 40)); handlers.pointermove(event(100, 42)); handlers.pointercancel(); handlers.pointerup(event(100, 42));
assert.equal(renders, 3);
shell.isConnected = false; buttons[0]();
assert.equal(renders, 3);

assert.equal(LUCIDE_STROKE_WIDTH, 2.25);
for (const [semantic, glyph] of Object.entries({ backstage: 'feather', 'floor-tools': 'text-align-start', 'world-map': 'orbit', focus: 'leaf' })) {
  const markup = qianmuIconMarkup(semantic);
  // Compare geometry instead of unstable signature names.
  const body = markup.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)[1];
  assert.equal(body, LUCIDE_ICON_MARKUP[glyph], `${semantic} uses ${glyph}`);
}
assert.match(source, /id: 'theater'[^\n]*qm-regular-tv/);
assert.match(source, /id: 'imagegen'[^\n]*qm-regular-aperture/);
assert.match(source, /button\.innerHTML = '<i class="fa-solid fa-video" data-qm-icon="qm-regular-aperture"/);
assert.match(css, /\.sd-world-viewport \{[^}]*min-height: 0/);
assert.doesNotMatch(css.match(/\.sd-world-edge \{[^}]*}/)?.[0] || '', /top: 50%/);
assert.match(css, /\.sd-tab.active \{[^}]*background: transparent !important;[^}]*box-shadow: none !important;/);
assert.match(css, /\.sd-storyboard-assets-tabs \{ border-radius: 9px; }/);
console.log('World edge navigation, local semantic icons and visual contracts OK');
