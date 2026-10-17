import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { htmlEscape } from '../qianmu-storyboard-utils.js';
import { renderCreativeSocialCard, bindCreativeSocialEvents, resetCreativeSocialState } from '../qianmu-creative-social.js';

const diary = { type: 'fourth_wall', form: 'diary', title: '页边留下的事', character: '林芷',
  entries: Array.from({ length: 7 }, (_, index) => ({ time: `十月${index + 1}日 · 夜`,
    content: `我把第${index + 1}张收据夹在书里。\n\n${'我没有替旁人决定明天的生活，只把自己看到的这一页留下。'.repeat(20)}\n今天到这里。` })) };
const keyOf = item => /data-qm-social="([^"]+)"/.exec(renderCreativeSocialCard(item))[1];
test.beforeEach(() => resetCreativeSocialState());

test('diary is a read-only fourth-wall page with every ordered timestamp and full paragraph', () => {
  const before = JSON.stringify(diary), html = renderCreativeSocialCard(diary);
  assert.ok(diary.entries.reduce((sum, entry) => sum + (entry.content.match(/\p{Script=Han}/gu) || []).length, 0) >= 2000);
  assert.match(html, /<h3>幕间拾趣<\/h3>/);
  assert.match(html, /一幕之遥 · 独立番外/);
  assert.doesNotMatch(html, /第四面墙/);
  assert.match(html, /sd-fourth-wall-diary/);
  assert.match(html, /<span>林芷<\/span><span aria-hidden="true">·<\/span><span>日记<\/span>/);
  assert.match(html, /data-qm-social-scroll tabindex="0" role="region" aria-label="一幕之遥日记"/);
  assert.equal((html.match(/class="sd-fourth-wall-entry"/g) || []).length, diary.entries.length);
  let previous = -1;
  for (const entry of diary.entries) {
    const next = html.indexOf(`<time>${entry.time}</time>`); assert.ok(next > previous); previous = next;
    for (const paragraph of entry.content.split('\n\n')) assert.ok(html.includes(`<p>${htmlEscape(paragraph)}</p>`));
  }
  assert.doesNotMatch(html, /<button|<input|<textarea|<form|contenteditable|data-qm-social-action|sd-social-avatar|sd-social-message|写入|生成按钮/);
  assert.equal(JSON.stringify(diary), before);
});

test('scene retains long prose, normal paragraphs and single line breaks without feed controls', () => {
  const content = '开头一段。\r\n这里仍属同段。\r\n\r\n' + '角色把窗外一段正在发生的事情看完。'.repeat(800) + '\n\n末尾原文仍在。';
  const item = { type: 'fourth_wall', form: 'scene', title: '车窗另一边', character: '周宁', content };
  const html = renderCreativeSocialCard(item);
  assert.match(html, /sd-fourth-wall-scene/);
  assert.match(html, /一幕之遥 · 独立番外/);
  assert.match(html, /aria-label="一幕之遥旁观"/);
  assert.doesNotMatch(html, /第四面墙/);
  assert.match(html, /<span>周宁<\/span><span aria-hidden="true">·<\/span><span>旁观<\/span>/);
  assert.ok(html.includes('<p>开头一段。\n这里仍属同段。</p>'));
  assert.ok(html.includes(`<p>${'角色把窗外一段正在发生的事情看完。'.repeat(800)}</p>`));
  assert.ok(html.includes('<p>末尾原文仍在。</p>'));
  assert.doesNotMatch(html, /sd-fourth-wall-entry|data-qm-social-action|<button/);
  assert.equal(item.content, content);
});

test('short, old or partial pages keep every usable entry without pretending they met generation quotas', () => {
  const item = { ...diary, title: '', character: '', entries: [null, {}, { time: '应保留', content: '我仍记得这半页。' }, { time: '空页', content: ' ' }] };
  const html = renderCreativeSocialCard(item, { notice: '本幕返回不完整' });
  assert.match(html, /本幕返回不完整/);
  assert.match(html, /<time>应保留<\/time>/);
  assert.match(html, /我仍记得这半页。/);
  assert.doesNotMatch(html, /空页|未标时间|至少|不足|2000|5则|data-qm-social-action/);
  assert.equal((html.match(/class="sd-fourth-wall-entry"/g) || []).length, 1);
  const untimed = renderCreativeSocialCard({ ...diary, entries: [{ content: '没有时间标记的旧段落仍可阅读。' }] });
  assert.match(untimed, /没有时间标记的旧段落仍可阅读。/);
  assert.doesNotMatch(untimed, /<time>/);
  assert.match(renderCreativeSocialCard({ type: 'fourth_wall', form: 'scene', content: '仅收到一句。' }, { notice: '本幕返回不完整' }), /仅收到一句。/);
});

test('unsupported shapes and empty fourth-wall pages show the standard empty label', () => {
  for (const item of [null, [], { type: 'fourth_wall' }, { type: 'fourth_wall', form: 'unknown', content: '不能假扮旁观页' },
    { type: 'fourth_wall', form: 'diary', entries: 'not an array' }, { type: 'fourth_wall', form: 'scene', content: {} },
    { type: 'fourth_wall', form: 'scene', entries: diary.entries }, { type: 'fourth_wall', form: 'diary', content: '不猜测缺失结构' }]) {
    const html = renderCreativeSocialCard(item);
    assert.match(html, /sd-social-empty">尚未生成/);
    assert.doesNotMatch(html, /sd-fourth-wall-reading|不能假扮旁观页|不猜测缺失结构/);
  }
});

test('all fourth-wall metadata and prose are escaped as text, never executable markup', () => {
  const unsafe = '<img src=x onerror="globalThis.hacked=true"><script>fetch("secret")</script>&"';
  for (const item of [
    { type: 'fourth_wall', form: 'diary', title: unsafe, character: unsafe, entries: [{ time: unsafe, content: unsafe }] },
    { type: 'fourth_wall', form: 'scene', title: unsafe, character: unsafe, content: unsafe },
  ]) {
    const html = renderCreativeSocialCard(item, { notice: unsafe });
    assert.ok(html.includes(htmlEscape(unsafe)));
    assert.doesNotMatch(html, /<(?:img|script|a)\b|onerror="|<[^>]*\s(?:href|src)=/);
  }
});

test('normal diary entries have no display ceiling and one result never changes another form', () => {
  const entries = Array.from({ length: 77 }, (_, index) => ({ time: `第${index + 1}页`, content: `我留下第${index + 1}页完整文字。` }));
  const html = renderCreativeSocialCard({ ...diary, entries });
  assert.equal((html.match(/class="sd-fourth-wall-entry"/g) || []).length, 77);
  assert.match(html, /我留下第77页完整文字。/);
  assert.notEqual(keyOf(diary), keyOf({ ...diary, form: 'scene', content: '一则旁观。' }));
  assert.notEqual(keyOf(diary), keyOf({ ...diary, character: '另一个角色' }));
});

function scrollFixture(key) {
  const listeners = new Map();
  const card = { dataset: { qmSocial: key } };
  const viewport = { scrollTop: 0, matches: selector => selector === '[data-qm-social-scroll]', closest: () => card };
  const root = { contains: node => node === viewport || node === card, querySelectorAll: () => [viewport],
    addEventListener: (kind, callback) => { if (!listeners.has(kind)) listeners.set(kind, new Set()); listeners.get(kind).add(callback); },
    removeEventListener: (kind, callback) => listeners.get(kind)?.delete(callback) };
  return { root, viewport, scroll: top => { viewport.scrollTop = top; for (const listener of listeners.get('scroll') || []) listener({ target: viewport }); } };
}

test('read-only long pages reuse local scroll restoration without persistence or mainline effects', () => {
  const before = JSON.stringify(diary), first = scrollFixture(keyOf(diary));
  bindCreativeSocialEvents(first.root); first.scroll(910);
  const second = scrollFixture(keyOf(diary)); bindCreativeSocialEvents(second.root);
  assert.equal(second.viewport.scrollTop, 910);
  const changed = scrollFixture(keyOf({ ...diary, title: '另一组番外' })); bindCreativeSocialEvents(changed.root);
  assert.equal(changed.viewport.scrollTop, 0);
  resetCreativeSocialState(); const cleared = scrollFixture(keyOf(diary)); bindCreativeSocialEvents(cleared.root);
  assert.equal(cleared.viewport.scrollTop, 0);
  assert.equal(JSON.stringify(diary), before);
});

test('fourth-wall layout is modal-scoped, uses the normal prose scale and avoids clipping text', async () => {
  const css = await readFile(new URL('../qianmu-creative-social.css', import.meta.url), 'utf8');
  assert.match(css, /#story-director-modal \.sd-fourth-wall-prose\s*\{[^}]*font-size:\s*var\(--qm-type-body, 12px\)[^}]*line-height:\s*1\.85/);
  assert.match(css, /#story-director-modal \.sd-fourth-wall-prose p\s*\{[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(css, /\.sd-fourth-wall[^}]*-webkit-line-clamp/);
  const source = await readFile(new URL('../qianmu-creative-social.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|injectToInput|saveSettings)\b/);
});
