import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { showPendingPanel } from '../qianmu-pending-panel.js';

function fakeDocument() {
  const make = tag => { const node = { tag, children: [], attrs: {}, className: '', id: '', textContent: '', parent: null,
    setAttribute(key, value) { node.attrs[key] = value; }, append(...items) { for (const item of items) { item.parent = node; node.children.push(item); } },
    remove() { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); node.parent = null; } }; return node; };
  const body = make('body');
  return { body, createElement: make, getElementById: id => body.children.find(child => child.id === id) || null };
}

test('a fast open never shows the stand-in; a slow one shows it until the real panel settles', async () => {
  const timers = []; const schedule = (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, cancel = id => { timers[id - 1].fn = () => {}; };
  const document = fakeDocument();
  let settle; const fast = new Promise(resolve => { settle = resolve; });
  showPendingPanel({ document, title: '正文收藏', label: '正在读取收藏…', until: fast, schedule, cancel });
  settle(true); await fast; await Promise.resolve(); timers[0].fn();
  assert.equal(document.body.children.length, 0, 'settled before the delay: nothing was inserted');

  let fail, mounted = 0; const slow = new Promise((_, reject) => { fail = reject; });
  showPendingPanel({ document, title: '正文收藏', label: '正在读取收藏…', until: slow, themeClass: 'sd-theme-light', mount: () => { mounted++; }, schedule, cancel });
  assert.equal(timers[1].ms, 90); timers[1].fn();
  const layer = document.getElementById('qianmu-pending-panel');
  assert.ok(layer); assert.equal(layer.className, 'sd-theme-light'); assert.equal(mounted, 1);
  const card = layer.children[0]; assert.equal(card.attrs.role, 'status');
  assert.equal(card.children[0].textContent, '正文收藏'); assert.equal(card.children[1].children[1].textContent, '正在读取收藏…');
  fail(new Error('open failed')); await slow.catch(() => {}); await Promise.resolve();
  assert.equal(document.getElementById('qianmu-pending-panel'), null, 'a failed open removes the stand-in too');
});

test('the collection entry shows the stand-in, and surfaces that paint first say they are still reading', async () => {
  const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
  assert.match(await read('qianmu-prose-floor-tools.js'), /openCollection:\(\)=>\{const opening=collectionHost\(\)\.open\(\);options\.pending\?\.\('正文收藏','正在读取收藏…',opening\);return opening;\}/);
  const entry = await read('index.js');
  assert.match(entry, /const proseFloorTools=createProseFloorTools\(\{pending:pendingPanel,/);
  assert.match(await read('qianmu-prose-assistant-panel.js'), /if\(!historyNotice\.textContent\)historyNotice\.textContent=READING_HISTORY;[\s\S]*if\(historyNotice\.textContent===READING_HISTORY\)historyNotice\.textContent='';/);
  assert.match(await read('style.css'), /:is\(\.sd-character-archive-host, \.sd-comfy-library-host, \.sd-comfy-pool-host, \.sd-vibe-library-host, \.sd-ensemble-library-host\):empty::before \{ content: '正在载入…'/);
  // The two forced early layouts found by profiling stay out of the render path.
  assert.doesNotMatch(await read('qianmu-main-tabs.js'), /next\.replaceWith\(previous\);previousBar\.scrollLeft=scroll/);
  assert.match(entry, /sync:\(\)=>appearanceSession\.settle\(\)/);
  assert.match(await read('qianmu-appearance-session.js'), /settle\(\) \{ return settled\(\) \? Promise\.resolve\(ready\) : sync\(\); \}/);
});
