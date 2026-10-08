import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderCreativeSocialCard, bindCreativeSocialEvents, resetCreativeSocialState } from '../qianmu-creative-social.js';

const forum = { type: 'forum', title: '桥头今日事', posts: [
  { author: '卖花的阿姨', handle: 'rose', time: '片刻前', content: '买了花却忘记带伞的人，可以回来躲雨。', replies: [
    { author: '邮差', content: '伞已经送到，他把花也忘在我这了。' },
  ] },
] };
const phone = { type: 'phone', title: '夜班互助', owner: '林芷', conversation_kind: 'group',
  messages: Array.from({ length: 8 }, (_, i) => ({ sender: i % 2 ? '林芷' : '同事', content: `消息${i + 1}`, time: `20:0${i}` })) };

test.beforeEach(() => resetCreativeSocialState());

test('forum is structured feed with existing Qianmu icons and local actions', () => {
  const html = renderCreativeSocialCard(forum);
  assert.match(html, /<h3>幕间拾趣<\/h3>/);
  assert.doesNotMatch(html, /众人正在说|消息一隅|<span>世界论坛<\/span>/);
  assert.match(html, /data-qm-social-scroll tabindex="0" role="region"/);
  assert.match(html, /class="sd-social-post"/);
  assert.match(html, /@rose/);
  assert.match(html, /data-qm-social-action="like"/);
  assert.match(html, /data-qm-social-action="bookmark"/);
  assert.match(html, /aria-controls="social-.*-replies-0"/);
  assert.match(html, /qm-glyph-icon/);
  assert.match(html, /class="sd-social-action-label"/);
  assert.doesNotMatch(html, /<img|<a\b|<form|textarea|contenteditable|写入输入框|发帖|发送/);
});

test('all model text remains text, including names, handles, titles, replies and timestamps', () => {
  const injection = '"><img src=x onerror=alert(1)><script>fetch("secret")</script>';
  const html = renderCreativeSocialCard({ type: 'forum', title: injection, posts: [{
    author: injection, handle: injection, content: injection, time: injection,
    replies: [{ author: injection, content: injection }],
  }] });
  assert.doesNotMatch(html, /<img|<script|onerror="|href=/);
  assert.match(html, /&lt;img/);
});

test('structured phone displays every message inside an accessible scroll viewport', () => {
  const html = renderCreativeSocialCard(phone);
  assert.equal((html.match(/class="sd-social-message(?: sd-social-message-own)?"/g) || []).length, 8);
  assert.equal((html.match(/sd-social-message-own"/g) || []).length, 4);
  assert.match(html, /林芷的手机/);
  assert.match(html, /data-qm-social-scroll tabindex="0" aria-label="群聊消息"/);
  assert.doesNotMatch(html, /人发言|人群聊|展开后续|data-social-message-extra| hidden/);
  assert.doesNotMatch(html, /data-qm-social-action="like"|textarea|发送|input/);
});

test('direct conversation and short message list do not add a fake send affordance', () => {
  const html = renderCreativeSocialCard({ ...phone, conversation_kind: 'direct', messages: phone.messages.slice(0, 6) });
  assert.match(html, /林芷的手机/);
  assert.match(html, /aria-label="私信消息"/);
  assert.doesNotMatch(html, /sd-social-expand|data-social-message-extra|type="submit"/);
});

test('legacy theater and phone prose remain readable without invented structured data', () => {
  for (const type of ['phone', 'theater']) {
    const html = renderCreativeSocialCard({ type, title: '旧标题', owner: '林芷', content: '旧正文\n第二行' });
    assert.match(html, /sd-social-legacy/);
    assert.match(html, /旧正文\n第二行/);
    assert.doesNotMatch(html, /data-qm-social-action|sd-social-post"|sd-social-message"/);
  }
});

test('unknown, malformed and absent forms fail closed to a safe empty state', () => {
  for (const item of [null, undefined, [], {}, { type: 'other', content: '<img>' },
    { type: 'forum', posts: ['text', null, 1, { author: '甲' }] },
    { type: 'phone', messages: [null, { content: 'missing sender' }] }]) {
    const html = renderCreativeSocialCard(item);
    assert.match(html, /尚未生成/);
    assert.doesNotMatch(html, /data-qm-social-action|undefined|\[object Object\]|<img/);
  }
});

test('post without responses has a disabled reply control, not a pretend new reply', () => {
  const html = renderCreativeSocialCard({ ...forum, posts: [{ ...forum.posts[0], replies: [] }] });
  assert.match(html, /data-qm-social-action="replies"[\s\S]*? disabled>/);
  assert.match(html, /回复 0/);
});

test('rendering uses stable content identity across object key order, ignoring unknown provider fields', () => {
  assert.equal(renderCreativeSocialCard(forum), renderCreativeSocialCard({ posts: forum.posts, title: forum.title, type: 'forum', ignored: 'server detail' }));
  const oldId = /data-qm-social="([^"]+)"/.exec(renderCreativeSocialCard(forum))[1];
  const newId = /data-qm-social="([^"]+)"/.exec(renderCreativeSocialCard({ ...forum, title: '另一天' }))[1];
  assert.notEqual(oldId, newId);
});

test('renderer and local interactions do not mutate generated source objects', () => {
  const before = JSON.stringify(forum), beforePhone = JSON.stringify(phone);
  renderCreativeSocialCard(forum); renderCreativeSocialCard(phone);
  assert.equal(JSON.stringify(forum), before); assert.equal(JSON.stringify(phone), beforePhone);
});

function fakeRoot(key) {
  const listeners = new Set(), scrollListeners = new Set();
  const card = { dataset: { qmSocial: key } };
  const viewport = { scrollTop: 0, matches: selector => selector === '[data-qm-social-scroll]', closest: () => card };
  const root = { addEventListener: (type, fn) => (type === 'scroll' ? scrollListeners : listeners).add(fn),
    removeEventListener: (type, fn) => (type === 'scroll' ? scrollListeners : listeners).delete(fn),
    querySelectorAll: () => [viewport], contains: node => node === card || node === button || node === viewport };
  const label = { textContent: '' }, attrs = {};
  const button = { disabled: false, dataset: { qmSocialAction: 'like', socialIndex: '0' },
    closest: selector => selector === '.sd-creative-social' ? card : button,
    setAttribute: (name, value) => { attrs[name] = value; }, querySelector: selector => selector === '.sd-social-action-label' ? label : null };
  return { root, button, label, attrs, listeners, scrollListeners, viewport,
    click: () => { for (const listener of listeners) listener({ target: button }); },
    scroll: top => { viewport.scrollTop = top; for (const listener of scrollListeners) listener({ target: viewport }); } };
}

test('binding is idempotent and reactions remain local across rerenders until reset', () => {
  const key = /data-qm-social="([^"]+)"/.exec(renderCreativeSocialCard(forum))[1];
  const fixture = fakeRoot(key);
  const oldDispose = bindCreativeSocialEvents(fixture.root);
  const dispose = bindCreativeSocialEvents(fixture.root);
  oldDispose();
  assert.equal(fixture.listeners.size, 1);
  fixture.click();
  assert.equal(fixture.attrs['aria-pressed'], 'true');
  assert.equal(fixture.label.textContent, '已赞');
  assert.match(renderCreativeSocialCard(forum), /data-qm-social-action="like"[^>]*aria-pressed="true"/);
  fixture.click();
  assert.equal(fixture.attrs['aria-pressed'], 'false');
  fixture.click(); resetCreativeSocialState();
  assert.match(renderCreativeSocialCard(forum), /data-qm-social-action="like"[^>]*aria-pressed="false"/);
  dispose(); assert.equal(fixture.listeners.size, 0); assert.equal(fixture.scrollListeners.size, 0);
});

test('same-result remount restores local scroll position, a new result and reset start at top', () => {
  const key = /data-qm-social="([^"]+)"/.exec(renderCreativeSocialCard(phone))[1];
  const first = fakeRoot(key); bindCreativeSocialEvents(first.root); first.scroll(240);
  const remounted = fakeRoot(key); bindCreativeSocialEvents(remounted.root);
  assert.equal(remounted.viewport.scrollTop, 240);
  const changedKey = /data-qm-social="([^"]+)"/.exec(renderCreativeSocialCard({ ...phone, title: '另一个群' }))[1];
  const changed = fakeRoot(changedKey); bindCreativeSocialEvents(changed.root);
  assert.equal(changed.viewport.scrollTop, 0);
  resetCreativeSocialState();
  const cleared = fakeRoot(key); bindCreativeSocialEvents(cleared.root);
  assert.equal(cleared.viewport.scrollTop, 0);
});

test('phone title fallback is the actual interlocutor, not an invented chapter heading', () => {
  const html = renderCreativeSocialCard({ ...phone, title: '', conversation_kind: 'direct' });
  assert.match(html, /<strong>同事<\/strong>/);
  assert.doesNotMatch(html, /<strong>消息<\/strong>|消息一隅/);
});

test('nested streamed host and modal listeners handle the same click only once', () => {
  const key = /data-qm-social="([^"]+)"/.exec(renderCreativeSocialCard(forum))[1];
  const fixture = fakeRoot(key), parentListeners = new Set();
  const parent = { contains: () => true, addEventListener: (_, fn) => parentListeners.add(fn), removeEventListener: (_, fn) => parentListeners.delete(fn) };
  bindCreativeSocialEvents(parent); bindCreativeSocialEvents(fixture.root);
  let stopped = false;
  const event = { target: fixture.button, stopPropagation: () => { stopped = true; } };
  for (const listener of fixture.listeners) listener(event);
  if (!stopped) for (const listener of parentListeners) listener(event);
  assert.equal(stopped, true);
  assert.equal(fixture.attrs['aria-pressed'], 'true');
  assert.equal(fixture.label.textContent, '已赞');
});

test('session state is bounded and an evicted result returns unselected', () => {
  const key = /data-qm-social="([^"]+)"/.exec(renderCreativeSocialCard(forum))[1];
  const fixture = fakeRoot(key); bindCreativeSocialEvents(fixture.root); fixture.click();
  for (let i = 0; i < 60; i++) renderCreativeSocialCard({ ...forum, title: `其他结果${i}` });
  assert.match(renderCreativeSocialCard(forum), /data-qm-social-action="like"[^>]*aria-pressed="false"/);
});

test('module contains no persistent or external side-effect API', async () => {
  const source = await readFile(new URL('../qianmu-creative-social.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|injectToInput|saveSettings)\b/);
});
