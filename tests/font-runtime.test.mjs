import test from 'node:test';
import assert from 'node:assert/strict';
import { createFontRuntime, fontPreviewFamily, fontScopeCss } from '../qianmu-font-runtime.js';

function fixture({ load, readLocal, loadTimeout = 100, accountKey = 'alice' } = {}) {
  const faces = new Set(), elements = [], statuses = [], requests = [], revoked = [], anchors = [];
  const document = {
    fonts: {
      add: (face) => faces.add(face), delete: (face) => faces.delete(face),
      async load(font, sample) { requests.push({ font, sample }); return load ? load(font, sample) : [...faces].filter((face) => font.includes(face.family)); },
    },
    head: { appendChild(node) { elements.push(node); } },
    createElement() { return { dataset: {}, textContent: '', remove() { const index = elements.indexOf(this); if (index >= 0) elements.splice(index, 1); } }; },
  };
  class FontFace { constructor(family, source, descriptors) { Object.assign(this, { family, source, descriptors }); } }
  const runtime = createFontRuntime({ document, FontFace, readLocal, accountKey, loadTimeout,
    onStatus: (id, value) => statuses.push({ id, ...value }),
    beforeApply: () => { anchors.push('before'); return 7; }, afterApply: (token) => anchors.push(token),
    URL: { createObjectURL: () => 'blob:owned-font', revokeObjectURL: (url) => revoked.push(url) },
  });
  return { runtime, faces, elements, statuses, requests, revoked, anchors, css: () => elements.map((node) => node.textContent).join('\n') };
}
const web = (id = 'web1', face = {}) => ({ id, source: { kind: 'web' }, faces: [{ urls: [{ url: 'https://fonts.example/font.woff2', format: 'woff2' }], weight: '400', style: 'normal', ...face }] });
const choice = (fontId, extra = {}) => ({ fontId, weight: 400, style: 'normal', enabled: true, ...extra });
const state = (fonts, assignments = {}) => ({ fonts, mode: 'separate', previewText: '人间有信 Aa', ...assignments });

test('native message metadata and recent-chat text are exact body targets, excluded from interface inheritance', () => {
  const body = fontScopeCss('body', fontPreviewFamily('body')), st = fontScopeCss('st', fontPreviewFamily('interface'));
  for (const leaf of ['.mesIDDisplay', '.mes_timer', '.tokenCounterDisplay', '.name_text', '.timestamp', '.swipes-counter', '.chatName', '.chatDate', '.chatMessage', '.chatStats small']) {
    assert.ok(body.includes(leaf), leaf);
  }
  assert.ok(body.includes('#chat > .mes > .mes_block > .ch_name'));
  assert.ok(body.includes('.welcomePanel .recentChatList > .recentChat > .recentChatInfo'));
  assert.ok(st.includes(':not(:is(#chat > .mes > .mesAvatarWrapper,'));
  assert.ok(st.includes('.ch_name .name_text, .ch_name .timestamp, .recentChatInfo))'));
  assert.doesNotMatch(body, /\.recentChat\s*\*|\.mes\s*\*|font-size:|line-height:/);
});

test('chat composer belongs only to the body assignment without introducing size or placeholder overrides', () => {
  const body = fontScopeCss('body', fontPreviewFamily('body-font'), { weight: '700', style: 'italic' });
  const st = fontScopeCss('st', fontPreviewFamily('ui-font'));
  assert.match(body, /textarea#send_textarea,\n#chat /);
  assert.match(body, /font-weight:700 !important; font-style:italic !important;/);
  assert.match(st, /:not\(:is\(textarea#send_textarea,/);
  assert.ok(st.includes(':not(:has(textarea#send_textarea, .mes_text,'), 'the interface must not change composer ancestors either');
  assert.ok(st.includes('button, input, textarea, select'), 'other host controls remain in the interface scope');
  for (const css of [body, st]) assert.doesNotMatch(css, /font-size:|line-height:|::placeholder/);
});

test('composer body rules share failure retention, restore, shared selection and master disable semantics', async () => {
  const f = fixture({ load: async request => { if (request.includes(fontPreviewFamily('bad'))) throw Error('unavailable'); return [{}]; } });
  const fonts = [web('body-font'), web('ui-font'), web('bad')], body = choice('body-font', { weight: '700', style: 'italic' }), st = choice('ui-font');
  await f.runtime.sync(state(fonts, { body, st }));
  const applied = f.css();
  assert.ok(applied.startsWith(fontScopeCss('body', f.runtime.family('body-font'), body)));
  assert.match(applied, /textarea#send_textarea,\n#chat /);
  await f.runtime.sync(state(fonts, { body: choice('bad'), st }));
  assert.equal(f.css(), applied, 'failed body replacement leaves both prose and composer on their previous font');
  await f.runtime.sync(state(fonts, { st }));
  assert.equal(f.css(), fontScopeCss('st', f.runtime.family('ui-font'), st), 'no body assignment leaves no composer override');
  const shared = choice('ui-font');
  await f.runtime.sync({ ...state(fonts), mode: 'shared', shared });
  assert.equal(f.css(), [fontScopeCss('body', f.runtime.family('ui-font'), shared), fontScopeCss('st', f.runtime.family('ui-font'), shared)].join('\n'));
  await f.runtime.sync({ ...state(fonts), enabled: false, mode: 'shared', shared }); assert.equal(f.css(), '');
  await f.runtime.sync(state(fonts, { body })); assert.match(f.css(), /textarea#send_textarea,\n#chat /);
  f.runtime.dispose(); assert.equal(f.css(), '');
});

test('actual application verification requires the exact current source, scope and selected variant', async () => {
  let reject = false; const f = fixture({ load: async () => { if (reject) throw Error('new source failed'); return [{}]; } });
  const font = web('exact', { weight: '200 900' }), selected = choice('exact', { weight: 600 });
  await f.runtime.sync(state([font], { body: selected }));
  assert.equal(f.runtime.isApplied('body', font, selected), true);
  assert.equal(f.runtime.isApplied('body', font, { ...selected, weight: '600' }), true);
  assert.equal(f.runtime.isApplied('st', font, selected), false);
  assert.equal(f.runtime.isApplied('body', font, { ...selected, weight: 700 }), false);
  assert.equal(f.runtime.isApplied('body', font, { ...selected, style: 'italic' }), false);
  assert.equal(f.runtime.isApplied('body', font, { ...selected, fontId: 'another' }), false);
  assert.equal(f.runtime.isApplied('body', font, { ...selected, enabled: false }), false);
  assert.equal(f.runtime.isApplied('body', { ...font, source: { kind: 'local' } }, selected), false);
  const replacement = web('exact', { weight: '200 900', urls: [{ url: 'https://fonts.example/replaced.woff2' }] }), before = f.css();
  assert.equal(f.runtime.isApplied('body', replacement, selected), false);
  reject = true; await f.runtime.sync(state([replacement], { body: selected }));
  assert.equal(f.css(), before, 'failed replacement retains the real former application');
  assert.equal(f.runtime.isApplied('body', replacement, selected), false, 'same ID does not make a failed new source applied');
  reject = false; await f.runtime.sync(state([replacement], { body: selected }));
  assert.equal(f.runtime.isApplied('body', replacement, selected), true);
  assert.equal(f.runtime.isApplied('body', font, selected), false);
  await f.runtime.sync(state([replacement], { enabled: false, body: selected })); assert.equal(f.runtime.isApplied('body', replacement, selected), false);
  f.runtime.dispose(); assert.equal(f.runtime.isApplied('body', replacement, selected), false);
});

test('application completion follows actual paint and precedes unrelated preview completion', async () => {
  let release, previewStarted = false; const hold = new Promise(resolve => { release = resolve; });
  const f = fixture({ load: async font => { if (font.includes(fontPreviewFamily('preview'))) { previewStarted = true; await hold; } return [{}]; } });
  const active = web('active'), selected = choice('active'); let callbacks = 0, done = false;
  const pending = f.runtime.sync(state([active, web('preview')], { body: selected }), ['preview'], { onApplied() { callbacks++; assert.match(f.css(), new RegExp(fontPreviewFamily('active'))); assert.equal(f.runtime.isApplied('body', active, selected), true); } }).then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(callbacks, 1); assert.equal(previewStarted, true); assert.equal(done, false);
  release(); await pending; assert.equal(callbacks, 1); f.runtime.dispose();
});

test('superseded and disposed application generations never invoke their completion callbacks', async () => {
  for (const dispose of [false, true]) {
    let release; const hold = new Promise(resolve => { release = resolve; }), f = fixture({ load: async () => { await hold; return [{}]; } });
    let older = 0, newer = 0; const pending = f.runtime.sync(state([web()], { body: choice('web1') }), [], { onApplied: () => older++ });
    await new Promise(resolve => setImmediate(resolve));
    if (dispose) f.runtime.dispose(); else await f.runtime.sync(state([], { enabled: false }), [], { onApplied: () => newer++ });
    release(); await pending; assert.equal(older, 0); assert.equal(newer, dispose ? 0 : 1); assert.equal(f.css(), ''); f.runtime.dispose();
  }
});

test('Web replacement verification is temporary and cannot change the applied face or catalogue slot', async () => {
  const f = fixture(); await f.runtime.sync(state([web()], { body: choice('web1') }));
  const css = f.css(), family = f.runtime.family('web1'), registered = [...f.faces], statuses = f.statuses.length;
  await f.runtime.verifyWebFont(web('web1', { urls: [{ url: 'https://fonts.example/new.woff2' }] }), choice('web1'), '样字');
  assert.equal(f.css(), css); assert.equal(f.runtime.family('web1'), family);
  assert.deepEqual([...f.faces], registered); assert.equal(f.statuses.length, statuses);
  f.runtime.dispose();
});

test('failed and disposed replacement probes release temporary faces without touching old data', async () => {
  let finish;
  const f = fixture({ load: async font => font.includes('_probe') ? new Promise(resolve => { finish = resolve; }) : [{}] });
  await f.runtime.sync(state([web()], { body: choice('web1') }));
  const pending = f.runtime.verifyWebFont(web(), choice('web1'), '字');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.faces.size, 2);
  f.runtime.dispose(); assert.equal(f.faces.size, 0); finish([{}]);
  await assert.rejects(pending, /已关闭/); assert.equal(f.faces.size, 0); assert.equal(f.css(), '');
  const failed = fixture({ load: async () => { throw Error('bad binary'); } });
  await assert.rejects(failed.runtime.verifyWebFont(web(), choice('web1'), '字'), /bad binary/);
  assert.equal(failed.faces.size, 0); assert.equal(failed.css(), ''); failed.runtime.dispose();
});

test('same-id Web source replacement loads a fresh family and releases its previous face only after success', async () => {
  const f = fixture(), original = web(), selected = { body: choice('web1'), st: choice('web1') };
  await f.runtime.sync(state([original], selected));
  const firstFamily = f.runtime.family('web1'), firstFace = [...f.faces][0];
  const edited = web('web1', { urls: [{ url: 'https://fonts.example/new.woff2' }] });
  await f.runtime.sync(state([edited], selected));
  assert.notEqual(f.runtime.family('web1'), firstFamily);
  assert.ok(f.css().includes(f.runtime.family('web1'))); assert.ok(!f.css().includes('"' + firstFamily + '"'));
  assert.equal(f.faces.has(firstFace), false); assert.equal(f.faces.size, 1);
  const latestFamily = f.runtime.family('web1');
  await f.runtime.sync(state([{ ...edited, name: '只改名' }], selected));
  assert.equal(f.runtime.family('web1'), latestFamily); f.runtime.dispose(); assert.equal(f.faces.size, 0);
});

test('failed same-id replacement retains actual old application until successful edit or master-off', async () => {
  let failNew = false;
  const f = fixture({ load: async () => { if (failNew) throw new Error('new binary failed'); return [{}]; } });
  const selected = { body: choice('web1'), st: choice('web1') };
  await f.runtime.sync(state([web()], selected));
  const firstCss = f.css(), oldFace = [...f.faces][0]; failNew = true;
  const edited = web('web1', { urls: [{ url: 'https://fonts.example/invalid.woff2' }] });
  await f.runtime.sync(state([edited], selected));
  assert.equal(f.css(), firstCss); assert.equal(f.faces.has(oldFace), true);
  assert.equal(f.statuses.at(-1).status, 'error');
  await f.runtime.sync(state([edited], { ...selected, enabled: false }));
  assert.equal(f.css(), ''); assert.equal(f.faces.size, 0); f.runtime.dispose();
});

test('an earlier same-id edit resolving late cannot replace a newer successful source', async () => {
  let finish, loading = false;
  const f = fixture({ load: async () => loading ? new Promise(resolve => { finish = resolve; loading = false; }) : [{}] });
  const selected = { body: choice('web1') };
  await f.runtime.sync(state([web()], selected)); loading = true;
  const oldEdit = f.runtime.sync(state([web('web1', { urls: [{ url: 'https://fonts.example/slow.woff2' }] })], selected));
  await new Promise(resolve => setImmediate(resolve));
  await f.runtime.sync(state([web('web1', { urls: [{ url: 'https://fonts.example/latest.woff2' }] })], selected));
  const css = f.css(); finish([{}]); await oldEdit;
  assert.equal(f.css(), css); assert.equal(f.faces.size, 1); f.runtime.dispose();
});

test('master off removes both scopes immediately while preserving selected fonts and independent previews', async () => {
  let finish;
  const f = fixture({ load: async font => font.includes(fontPreviewFamily('preview')) ? new Promise(resolve => { finish = resolve; }) : [{}] });
  const active = state([web('a'), web('b'), web('preview')], { body: choice('a'), st: choice('b'), shared: choice('a') });
  const original = structuredClone(active);
  await f.runtime.sync(active);
  assert.match(f.css(), new RegExp(fontPreviewFamily('a')));
  assert.match(f.css(), new RegExp(fontPreviewFamily('b')));
  const disabled = f.runtime.sync({ ...active, enabled: false }, ['preview']);
  assert.equal(f.css(), '', 'application styles are removed before preview loading completes');
  await new Promise(resolve => setImmediate(resolve));
  finish([{}]); await disabled;
  assert.equal(f.css(), ''); assert.equal(f.faces.size, 1);
  assert.deepEqual(active, original);
  await f.runtime.sync({ ...active, enabled: true, mode: 'shared' });
  assert.match(f.css(), new RegExp(fontPreviewFamily('a')));
  assert.doesNotMatch(f.css(), new RegExp(fontPreviewFamily('b')));
  await f.runtime.sync({ ...active, enabled: false, mode: 'shared' });
  assert.equal(f.css(), ''); assert.equal(f.faces.size, 0); f.runtime.dispose();
});

test('late success or rejection cannot revive application after master-off or off-on-off ordering', async () => {
  for (const rejects of [false, true]) {
    const pending = [];
    const f = fixture({ load: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
    const s = state([web()], { body: choice('web1'), st: choice('web1') });
    const first = f.runtime.sync(s);
    await new Promise(resolve => setImmediate(resolve));
    await f.runtime.sync({ ...s, enabled: false });
    const second = f.runtime.sync({ ...s, enabled: true });
    await new Promise(resolve => setImmediate(resolve));
    await f.runtime.sync({ ...s, enabled: false });
    for (const deferred of pending) rejects ? deferred.reject(new Error('late failure')) : deferred.resolve([{}]);
    await Promise.all([first, second]);
    assert.equal(f.css(), ''); assert.equal(f.faces.size, 0); f.runtime.dispose();
  }
});

test('preview failure with master off never falls back to a retained active assignment', async () => {
  const f = fixture({ load: async font => { if (font.includes(fontPreviewFamily('bad'))) throw new Error('network'); return [{}]; } });
  const s = state([web('good'), web('bad')], { body: choice('good'), st: choice('good') });
  await f.runtime.sync(s);
  await f.runtime.sync({ ...s, enabled: false }, ['bad']);
  assert.equal(f.css(), ''); assert.equal(f.statuses.at(-1).status, 'error'); f.runtime.dispose();
});

test('catalog registration and actual list verification do not apply to ST or prose', async () => {
  const f = fixture();
  await f.runtime.sync(state([web(), web('hidden')]), ['web1']);
  assert.equal(f.faces.size, 1); assert.equal(f.requests.length, 1);
  assert.equal(f.css(), ''); assert.deepEqual(f.anchors, []);
  assert.equal(f.statuses.at(-1).status, 'ready');
  assert.match([...f.faces][0].source, /^url\("https:/);
  f.runtime.dispose(); assert.equal(f.faces.size, 0);
});

test('independent body and interface use separate opaque fonts; no global font or size changes', async () => {
  const f = fixture();
  await f.runtime.sync(state([web('reading'), web('interface')], { body: choice('reading'), st: choice('interface', { weight: 500 }) }));
  assert.match(f.css(), new RegExp(fontPreviewFamily('reading')));
  assert.match(f.css(), new RegExp(fontPreviewFamily('interface')));
  assert.match(f.css(), /font-weight:500/);
  assert.doesNotMatch(f.css(), /font-size:|line-height:|--mainFontFamily\s*:/);
  assert.deepEqual(f.anchors, ['before', 7], 'the two scope changes paint together');
  f.runtime.dispose(); assert.equal(f.css(), '');
});

test('shared setting changes both scopes without mutating independent assignments', async () => {
  const f = fixture(), s = state([web('a'), web('b')], { mode: 'shared', body: choice('a'), st: choice('a'), shared: choice('b') });
  const original = JSON.stringify(s);
  await f.runtime.sync(s);
  assert.equal(JSON.stringify(s), original);
  assert.match(f.css(), new RegExp(fontPreviewFamily('b')));
  assert.doesNotMatch(f.css(), new RegExp(fontPreviewFamily('a')));
  assert.equal(f.requests.length, 1, 'shared verification coalesces identical face loads');
  await f.runtime.sync({ ...s, mode: 'separate' });
  assert.match(f.css(), new RegExp(fontPreviewFamily('a')));
  f.runtime.dispose();
});

test('preview-only load failure is visible and never styled as successful', async () => {
  const f = fixture({ load: async () => { throw new Error('CORS'); } });
  await f.runtime.sync(state([web()]), ['web1']);
  assert.equal(f.statuses.at(-1).status, 'error'); assert.match(f.statuses.at(-1).message, /CORS/);
  assert.equal(f.css(), ''); f.runtime.dispose();
});

test('failed replacement preserves prior applied font; deleting or disabling restores native', async () => {
  const f = fixture({ load: async (font) => { if (font.includes(fontPreviewFamily('bad'))) throw new Error('network'); return [{}]; } });
  await f.runtime.sync(state([web('good'), web('bad')], { body: choice('good') }));
  await f.runtime.sync(state([web('good'), web('bad')], { body: choice('bad') }));
  assert.match(f.css(), new RegExp(fontPreviewFamily('good')));
  assert.doesNotMatch(f.css(), new RegExp(fontPreviewFamily('bad')));
  await f.runtime.sync(state([web('good')], { body: choice('bad') }));
  assert.equal(f.css(), ''); assert.equal(f.faces.size, 0);
  f.runtime.dispose();
});

test('a stale asynchronous load cannot overwrite a newer disable or choice', async () => {
  let finish;
  const f = fixture({ load: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = f.runtime.sync(state([web()], { body: choice('web1') }));
  await new Promise((resolve) => setImmediate(resolve));
  await f.runtime.sync(state([web()], { body: choice('web1', { enabled: false }) }));
  finish([{}]); await pending;
  assert.equal(f.css(), ''); assert.equal(f.faces.size, 0); f.runtime.dispose();
});

test('a removed previous font cannot survive as replacement-failure fallback', async () => {
  const f = fixture({ load: async (font) => { if (font.includes(fontPreviewFamily('bad'))) throw new Error('network'); return [{}]; } });
  await f.runtime.sync(state([web('good')], { body: choice('good') }));
  await f.runtime.sync(state([web('bad')], { body: choice('bad') }));
  assert.equal(f.css(), '');
  assert.ok([...f.faces].every((face) => face.family !== fontPreviewFamily('good'))); f.runtime.dispose();
});

test('local font is read only under an account and owned object URL is revoked', async () => {
  const f = fixture({ readLocal: async () => new Blob(['font']) });
  const local = { id: 'local1', source: { kind: 'local' }, faces: [{ weight: '400', style: 'normal', urls: [] }] };
  await f.runtime.sync(state([local]), ['local1']);
  assert.equal(f.faces.size, 1); assert.equal([...f.faces][0].source, 'url("blob:owned-font")');
  f.runtime.dispose(); assert.deepEqual(f.revoked, ['blob:owned-font']);
  const missing = fixture({ accountKey: '', readLocal: async () => { throw new Error('must not read'); } });
  await missing.runtime.sync(state([local]), ['local1']);
  assert.match(missing.statuses.at(-1).message, /账户/); assert.equal(missing.faces.size, 0);
  missing.runtime.dispose();
});

test('missing local bytes reports actionable failure and retains native appearance', async () => {
  const f = fixture({ readLocal: async () => null });
  await f.runtime.sync(state([{ id: 'gone', source: { kind: 'local' }, faces: [{}] }], { st: choice('gone') }));
  assert.match(f.statuses.at(-1).message, /重新上传或导入/); assert.equal(f.css(), ''); f.runtime.dispose();
});

test('subset descriptors are preserved and active/preview sample is bounded', async () => {
  const f = fixture(), font = web('subset', { unicodeRange: 'U+4E00-9FFF', weight: '100 900', stretch: '75% 125%', style: 'oblique -10deg 20deg' });
  await f.runtime.sync({ ...state([font]), previewText: '中'.repeat(1000) }, ['subset']);
  const face = [...f.faces][0];
  assert.equal(face.descriptors.unicodeRange, 'U+4E00-9FFF'); assert.equal(face.descriptors.weight, '100 900');
  assert.equal(face.descriptors.stretch, '75% 125%'); assert.equal(f.requests[0].sample.length, 100); f.runtime.dispose();
  assert.equal(face.descriptors.style, 'oblique -10deg 20deg');
});

test('visible preview verifies the exact per-card weight and style', async () => {
  const f = fixture();
  await f.runtime.sync({ ...state([web()]), previewChoices: { web1: { weight: 700, style: 'italic' } } }, ['web1']);
  assert.match(f.requests[0].font, /^italic 700 /); assert.equal(f.css(), ''); f.runtime.dispose();
});

test('unsafe URL/CSS inputs cannot insert stylesheet rules or broaden invalid subsets', async () => {
  assert.match(fontPreviewFamily('x";} body {color:red}'), /^QianmuFont_[a-zA-Z0-9_]+$/);
  assert.equal(fontScopeCss('st', 'bad"}body{display:none}'), '');
  const f = fixture();
  await f.runtime.sync(state([web('bad', { urls: [{ url: 'javascript:alert(1)' }] })]), ['bad']);
  assert.equal(f.faces.size, 0); assert.equal(f.statuses.at(-1).status, 'error');
  await f.runtime.sync(state([web('bad-range', { unicodeRange: 'body {color:red}' })]), ['bad-range']);
  assert.equal(f.faces.size, 0); assert.match(f.statuses.at(-1).message, /字符分段/); f.runtime.dispose();
});

test('ST scope explicitly excludes message/rich prose, icons, code, Qianmu and their ancestors', () => {
  const css = fontScopeCss('st', fontPreviewFamily('sample'));
  for (const part of ['.mes_text *', 'pre *', 'code *', '[class*="fa-"]', '[class*="icon"]', '[id^="story-director-"]', ':not(:has(textarea#send_textarea, .mes_text', '[data-sd-prose-exempt]']) assert.ok(css.includes(part), part);
  assert.doesNotMatch(css, /html body\s*\{/);
  assert.ok(css.includes(':not(html):not(body)'), 'body-level Qianmu state classes must not exempt every ST descendant');
  const prose = fontScopeCss('body', fontPreviewFamily('sample'));
  assert.ok(prose.includes(':not(:has(style, .np-min-card'));
  assert.ok(prose.includes('> .sd-prose-run[data-sd-prose-run="1"]'));
  assert.ok(prose.includes('> :is(p, div):not([class], [style]):not(:has(style, .np-min-card'));
});

test('explicit application has a bounded cascade scope and fonts ordinary descendants directly', () => {
  const prose = fontScopeCss('body', fontPreviewFamily('sample'));
  const st = fontScopeCss('st', fontPreviewFamily('sample'));
  for (const css of [prose, st]) {
    assert.match(css, /^@layer qianmu-font-application \{/);
    assert.doesNotMatch(css, /#chat#chat|:root:root|--mainFontFamily\s*:/);
  }
  assert.match(prose, /:is\(p, div, span, a, b, strong, em, i, u, s, q,/);
  assert.ok(prose.includes('pre, code, kbd, samp, svg, canvas, .fa'));
  assert.ok(prose.includes('.np-min-card, [data-sd-prose-exempt]'));
  assert.ok(prose.includes(':not(.mes_text :is(pre, code, kbd, samp,'), 'authored-block ancestor exclusions stay within message content');
});

test('preview text outside declared ranges is reported without an unrelated probe', async () => {
  const f = fixture({ load: async () => [] });
  await f.runtime.sync(state([web('greek', { unicodeRange: 'U+0391-03A9' })]), ['greek']);
  assert.match(f.statuses.at(-1).message, /当前样字未匹配字体/);
  assert.equal(f.requests.length, 1); assert.equal(f.css(), ''); f.runtime.dispose();
});

test('activation may verify one declared-range character without claiming unrelated preview success', async () => {
  const f = fixture({ load: async (_font, sample) => sample === 'Α' ? [{}] : [] });
  await f.runtime.sync(state([web('greek', { unicodeRange: 'U+0391-03A9' })], { body: choice('greek') }), ['greek']);
  assert.equal(f.requests.filter((request) => request.sample === 'Α').length, 1);
  assert.match(f.css(), new RegExp(fontPreviewFamily('greek')));
  assert.match(f.statuses.at(-1).message, /当前样字未匹配字体/);
  f.runtime.dispose();
});

test('load timeout is bounded and never claims ready', async () => {
  const f = fixture({ load: () => new Promise(() => {}), loadTimeout: 5 });
  await f.runtime.sync(state([web()], { body: choice('web1') }));
  assert.equal(f.statuses.at(-1).status, 'error'); assert.match(f.statuses.at(-1).message, /超时/);
  assert.equal(f.css(), ''); f.runtime.dispose();
});
