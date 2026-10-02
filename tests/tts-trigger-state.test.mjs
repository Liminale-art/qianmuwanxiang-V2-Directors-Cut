import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

// Actual entry functions with local DOM/model/storage doubles. No provider calls.
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const tick = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor(className = '', tagName = 'div') {
    this.className = className; this.tagName = tagName; this.children = []; this.parent = null;
    this.dataset = {}; this.attributes = new Map(); this.hidden = false; this.disabled = false;
    this.isConnected = true; this._html = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, active) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        if (active) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
      },
    };
  }
  append(node) { node.parent = this; this.children.push(node); return node; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) { return selector.trim().split(',').some(part => part.trim().startsWith('.') ? part.trim().slice(1).split('.').every(name => this.classList.contains(name)) : this.tagName === part.trim()); }
  closest(selector) { for (let node = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  get innerHTML() { return this._html; }
  set innerHTML(value) {
    this._html = value;
    for (const child of this.children) child.parent = null;
    this.children = [];
    const icon = /<i class="([^"]+)"/.exec(value);
    if (icon) this.append(new Element(icon[1], 'i'));
  }
}

function fixture({loaded = true, collapsed = false} = {}) {
  const oldLines = [{speaker: '甲', text: '原来的台词'}], newLines = [{speaker: '甲', text: '新提取的台词'}];
  const mes = new Element('mes'), toolbar = mes.append(new Element('sd-tts-toolbar'));
  const button = (name, icon) => { const node = toolbar.append(new Element(name, 'button')); node.append(new Element(icon, 'i')); return node; };
  const trigger = button('sd-tts-trigger', 'fa-solid fa-clapperboard');
  const reextract = button('sd-tts-reextract', 'fa-solid fa-film');
  const regenerate = button('sd-tts-regenall', 'fa-solid fa-rotate');
  const play = button('sd-tts-playall', 'fa-regular fa-circle-play');
  const bar = mes.append(new Element('sd-tts-bar')), inline = mes.append(new Element('sd-tts-inline sd-tts-inline-playall', 'button'));
  inline.append(new Element('fa-regular fa-circle-play', 'i'));
  const row = bar.append(new Element('sd-tts-line')); row.textContent = oldLines[0].text;
  bar.dataset = loaded ? {loaded: '1', key: 'key', provider: 'fixture'} : {};
  bar.hidden = inline.hidden = collapsed;
  const cache = new Map(loaded ? [['key', oldLines]] : []), stored = new Map(cache);
  const calls = {prepare: 0, extract: 0, store: 0, render: 0, inject: 0, toggle: 0, stop: 0, play: 0, persisted: 0, notices: []};
  let prep = async () => {}, extract = deferred(), raw = '原始正文', chatKey = 'chat-one';
  const c = vm.createContext({Element, TTS_BAR_CLASS: 'sd-tts-bar', ttsRestoreTasks: 0, ttsIsCharacter: node => node === mes,
    getChatKey: () => chatKey, ttsEnsureBar: () => bar, ttsPrepareLineStore: () => { calls.prepare++; return prep(); },
    ttsRawText: () => raw, ttsContentKey: () => 'key', ttsLineCache: cache,
    ttsPersistedLines: key => { calls.persisted++; return stored.get(key); }, ttsMigrateLinesOnEdit: () => null,
    ttsCleanText: value => value, extractDialogue: () => { calls.extract++; return extract.promise; },
    ttsStoreLines: (key, lines) => { calls.store++; stored.set(key, lines); }, ttsMesId: () => '0',
    ttsAssignNpc: () => false, ttsProviderId: () => 'fixture', ttsPersistedAnchor: () => 'key',
    ttsRenderLines: (target, lines) => { calls.render++; target.innerHTML = lines.map(line => line.text).join('\n'); },
    ttsInjectInlineIcons: (_mes, lines) => { calls.inject++; inline.textContent = lines.map(line => line.text).join('\n'); },
    ttsToggleToolbarPlay: () => { calls.toggle++; }, ttsResolveVoice: () => true,
    setQianmuIconClass: (icon, value) => { if (icon) icon.className = value; }, applyQianmuIcons() {},
    toast: (...args) => calls.notices.push(args), htmlEscape: value => String(value).replaceAll('<', '&lt;'),
    ttsStopPlayback: () => { calls.stop++; }, ttsHandlePlayAll: () => { calls.play++; },
  });
  vm.runInContext(['ttsHandleTrigger', 'ttsOnChatClick', 'ttsApplyLines', 'ttsAutoRestore', 'ttsSetPlayingState'].map(section).join('\n'), c);
  return {c, mes, bar, trigger, reextract, regenerate, play, inline, row, oldLines, newLines, cache, stored, calls,
    run: (force = true) => c.ttsHandleTrigger(force ? reextract : trigger, force),
    prepare: fn => { prep = fn; }, resolve: value => extract.resolve(value ?? newLines), reject: error => extract.reject(error),
    next: () => { extract = deferred(); }, setRaw: value => { raw = value; }, setChat: value => { chatKey = value; }};
}

test('reextract click dispatches the actual reextract button, not the first extract control', () => {
  const f = fixture(), routed = [];
  f.c.ttsHandleTrigger = (...args) => routed.push(args);
  let prevented = 0;
  f.c.ttsOnChatClick({target: f.reextract.querySelector('i'), preventDefault() { prevented++; }});
  assert.equal(prevented, 1); assert.equal(routed.length, 1);
  assert.equal(routed[0][0], f.reextract); assert.equal(routed[0][1], true);
});

test('only reextract is busy; old lines stay readable during preparation and one model request', async () => {
  const f = fixture({collapsed: true}), prep = deferred(); f.prepare(() => prep.promise);
  const task = f.run();
  assert.equal(f.reextract.disabled, true); assert.equal(f.reextract.getAttribute('aria-busy'), 'true');
  assert.match(f.reextract.querySelector('i').className, /fa-spinner/);
  assert.equal(f.trigger.disabled, false); assert.equal(f.regenerate.disabled, false);
  assert.equal(f.trigger.querySelector('i').className, 'fa-solid fa-clapperboard');
  assert.equal(f.bar.children[0], f.row); assert.equal(f.bar.hidden, true);
  assert.equal(f.cache.get('key'), f.oldLines); assert.equal(f.stored.get('key'), f.oldLines);
  await f.run(); await f.run(false);
  assert.equal(f.bar.hidden, false); assert.equal(f.inline.hidden, false); assert.equal(f.bar.children[0], f.row);
  assert.equal(f.calls.prepare, 1); assert.equal(f.calls.extract, 0);
  prep.resolve(); await tick(); assert.equal(f.calls.extract, 1);
  await f.run(); f.c.ttsAutoRestore(f.mes);
  assert.equal(f.calls.extract, 1); assert.equal(f.calls.render, 0); assert.equal(f.calls.inject, 0);
  f.resolve(); await task;
  assert.equal(f.cache.get('key'), f.newLines); assert.equal(f.stored.get('key'), f.newLines);
  assert.equal(f.calls.store, 1); assert.equal(f.calls.render, 1); assert.equal(f.calls.inject, 1);
  assert.equal(f.bar.hidden, false); assert.equal(f.bar.dataset.loaded, '1'); assert.equal(f.bar.dataset.loading, '');
  assert.equal(f.reextract.disabled, false); assert.equal(f.reextract.getAttribute('aria-busy'), 'false');
  assert.equal(f.reextract.querySelector('i').className, 'fa-solid fa-film'); assert.equal(f.c.ttsRestoreTasks, 0);
});

test('failed reextract preserves cache, stored lines, row identity and inline state without retry', async () => {
  const f = fixture(), task = f.run(); await tick();
  f.reject(Error('model unavailable')); await task;
  assert.equal(f.calls.extract, 1); assert.equal(f.calls.store, 0); assert.equal(f.calls.render, 0); assert.equal(f.calls.inject, 0);
  assert.equal(f.cache.get('key'), f.oldLines); assert.equal(f.stored.get('key'), f.oldLines);
  assert.equal(f.bar.children[0], f.row); assert.equal(f.bar.dataset.loaded, '1'); assert.equal(f.bar.hidden, false);
  assert.equal(f.inline.parent, f.mes); assert.equal(f.inline.hidden, false);
  assert.equal(f.reextract.disabled, false); assert.equal(f.bar.dataset.loading, '');
  assert.match(f.calls.notices[0][0], /失败/); assert.equal(f.c.ttsRestoreTasks, 0);
  await tick(); assert.equal(f.calls.extract, 1);
});

test('preparation failure also restores busy state without replacing old content or calling a model', async () => {
  const f = fixture(); f.prepare(async () => { throw Error('local preparation failed'); });
  await f.run();
  assert.equal(f.calls.extract, 0); assert.equal(f.calls.store, 0); assert.equal(f.bar.children[0], f.row);
  assert.equal(f.reextract.disabled, false); assert.equal(f.bar.dataset.loading, ''); assert.equal(f.c.ttsRestoreTasks, 0);
});

test('successful replacement respects a list collapsed while reextract was pending', async () => {
  const f = fixture(), task = f.run(); await tick(); await f.run(false);
  assert.equal(f.bar.hidden, true); f.resolve(); await task;
  assert.equal(f.calls.extract, 1); assert.equal(f.bar.hidden, true); assert.equal(f.inline.hidden, true);
  assert.equal(f.bar.innerHTML, '新提取的台词');
});

test('an explicitly successful empty result replaces old lines only when the result arrives', async () => {
  const f = fixture(), task = f.run(); await tick();
  assert.equal(f.bar.children[0], f.row); f.resolve([]); await task;
  assert.equal(f.cache.get('key').length, 0); assert.equal(f.stored.get('key').length, 0);
  assert.equal(f.calls.store, 1); assert.equal(f.bar.dataset.loaded, '1');
});

test('ordinary warm toggles never prepare storage or invoke extraction', async () => {
  const f = fixture(); await f.run(false); await f.run(false);
  assert.equal(f.bar.hidden, false); assert.equal(f.bar.children[0], f.row);
  assert.equal(f.calls.prepare, 0); assert.equal(f.calls.extract, 0); assert.equal(f.calls.store, 0);
});

test('cold first extraction coalesces both entry buttons before the first await and stays manually retryable', async () => {
  const f = fixture({loaded: false}), prep = deferred(); f.prepare(() => prep.promise);
  const task = f.run(false); await f.run(false); await f.run(true);
  assert.equal(f.calls.prepare, 1); assert.equal(f.trigger.disabled, true); assert.equal(f.reextract.disabled, false);
  assert.match(f.trigger.querySelector('i').className, /fa-spinner/); assert.doesNotMatch(f.reextract.querySelector('i').className, /fa-spinner/);
  prep.resolve(); await tick(); assert.equal(f.calls.extract, 1);
  f.reject(Error('cold failure')); await task;
  assert.match(f.bar.innerHTML, /提取失败/); assert.equal(f.trigger.disabled, false); assert.equal(f.bar.dataset.loading, '');
  f.next(); const retry = f.run(false); await tick(); assert.equal(f.calls.extract, 2);
  f.resolve(); await retry; assert.equal(f.calls.store, 1); assert.equal(f.bar.dataset.loaded, '1');
});

test('ordinary unrendered cached lines are reused instead of reextracted', async () => {
  const f = fixture({loaded: false}); f.cache.set('key', f.oldLines);
  await f.run(false);
  assert.equal(f.calls.prepare, 1); assert.equal(f.calls.extract, 0); assert.equal(f.calls.store, 0);
  assert.equal(f.calls.render, 1); assert.equal(f.bar.dataset.loaded, '1');
});

test('leaving the original chat during preparation does not start extraction', async () => {
  const f = fixture(), prep = deferred(); f.prepare(() => prep.promise);
  const task = f.run(); f.setChat('chat-two'); prep.resolve(); await task;
  assert.equal(f.calls.extract, 0); assert.equal(f.calls.store, 0); assert.equal(f.calls.notices.length, 0);
  assert.equal(f.bar.children[0], f.row); assert.equal(f.reextract.disabled, false); assert.equal(f.c.ttsRestoreTasks, 0);
});

test('changing a character floor to user during preparation never starts extraction',async()=>{
  const f=fixture(),prep=deferred();f.prepare(()=>prep.promise);
  const task=f.run();f.c.ttsIsCharacter=()=>false;prep.resolve();await task;
  assert.equal(f.calls.extract,0);assert.equal(f.calls.store,0);assert.equal(f.c.ttsRestoreTasks,0);
});

test('late extraction cannot store or remount controls after a role change to user',async()=>{
  const f=fixture(),task=f.run();await tick();f.c.ttsIsCharacter=()=>false;f.resolve();await task;
  assert.equal(f.calls.store,0);assert.equal(f.calls.render,0);assert.equal(f.calls.inject,0);
  assert.equal(f.cache.get('key'),f.oldLines);assert.equal(f.c.ttsRestoreTasks,0);
});

for (const change of ['chat', 'text', 'message-detach', 'bar-replace']) test(`late extraction after ${change} cannot overwrite the confirmed cache or UI`, async () => {
  const f = fixture(), task = f.run(); await tick();
  if (change === 'chat') f.setChat('chat-two');
  else if (change === 'text') f.setRaw('已经修改的正文');
  else if (change === 'message-detach') f.mes.isConnected = false;
  else f.bar.remove();
  f.resolve(); await task;
  assert.equal(f.cache.get('key'), f.oldLines); assert.equal(f.stored.get('key'), f.oldLines);
  assert.equal(f.calls.store, 0); assert.equal(f.calls.render, 0); assert.equal(f.calls.inject, 0);
  assert.equal(f.calls.notices.length, 0); assert.equal(f.c.ttsRestoreTasks, 0);
});

test('late failure after switching chats is silent and does not erase old lines', async () => {
  const f = fixture(), task = f.run(); await tick(); f.setChat('chat-two');
  f.reject(Error('old request failed')); await task;
  assert.equal(f.calls.notices.length, 0); assert.equal(f.bar.children[0], f.row); assert.equal(f.c.ttsRestoreTasks, 0);
});

test('playing toolbar and inline controls retain the stop action class and dispatch stop, not regeneration', () => {
  const f = fixture(); f.c.ttsSetPlayingState(f.mes, true);
  for (const button of [f.play, f.inline]) {
    assert.equal(button.classList.contains('sd-tts-playing'), true);
    assert.equal(button.querySelector('i').className, 'fa-solid fa-circle-stop');
    f.c.ttsOnChatClick({target: button.querySelector('i'), preventDefault() {}});
  }
  assert.equal(f.calls.stop, 2); assert.equal(f.calls.play, 0);
  f.c.ttsSetPlayingState(f.mes, false);
  assert.equal(f.play.querySelector('i').className, 'fa-regular fa-circle-play');
  assert.equal(f.inline.querySelector('i').className, 'fa-regular fa-circle-play');
});
