import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';
import { createStoryboardMessageReference, resolveStoryboardMessageReference } from '../qianmu-storyboard.js';
import { hashText } from '../qianmu-storyboard-utils.js';

// Execute the production functions against in-memory host/storage doubles only.
// No ST requests, actual chat files, provider calls or browser data are touched.
const moduleName = 'story_director_liminale';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const line = text => [{ speaker: '角色', text, emotion: 'auto', speed: 1.1 }];

function ttsFixture(store = {}, local = null) {
  const host = { chatId: 'chat-A', chatMetadata: { [moduleName]: store }, chat: [{ mes: '原正文' }] };
  const calls = { save: 0, settings: 0, store: 0, reads: [], writes: [], scans: [], stopped: 0 };
  const timers = new Map();
  let timerId = 0, read = async () => local;
  const bars = [], chat = { querySelectorAll: () => bars, addEventListener() {}, removeEventListener() {} };
  const c = vm.createContext({
    console, Map, Set, Array, Object, String, Number, isPlainObject: plain, MODULE_NAME: moduleName,
    ctx: () => host, getChatKey: () => host.chatId,
    getChatStore: () => { calls.store++; return host.chatMetadata[moduleName]; },
    saveMetadata: () => { calls.save++; return Promise.resolve(); }, saveSettings: () => { calls.settings++; },
    blobStore: { blobStoreAvailable: () => true, getTtsLineCache: key => { calls.reads.push(key); return read(key); },
      putTtsLineCache: async (key, value) => { calls.writes.push({ key, value: structuredClone(value) }); } },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    TTS_LOCAL_LINE_LIMIT: 100, TTS_PORTABLE_LINE_LIMIT: 12, TTS_BAR_CLASS: 'tts-bar',
    ttsLineStoreState: { chatKey: '', lines: {}, keyByMes: {}, loaded: false }, ttsLineStorePromise: null,
    ttsLineStoreToken: 0, ttsLineStoreSaveTimer: null, ttsLineCache: new Map(),
    ttsProviderId: () => 'doubao', settings: { tts: { enabled: true, injectInChat: true } },
    document: { getElementById: () => chat }, MutationObserver: class { observe() {} disconnect() {} },
    ttsChatBound: false, ttsChatElement: null, ttsChatObserver: null, ttsOnChatClick() {}, ttsQueueMutationRecords() {},
    ttsStopChat: () => { calls.stopped++; },
    ttsScheduleInitialScan: (_chat, options) => calls.scans.push(options),
    ttsMesId: () => '0', ttsRawText: () => host.chat[0].mes, ttsCleanText: text => text,
  });
  const names = ['ttsPruneLineAnchors', 'ttsScheduleLocalLineSave', 'ttsFlushLocalLineStore', 'ttsPortableSnapshot',
    'ttsPrunePortableSnapshot', 'ttsPrepareLineStore', 'ttsPersistedLines', 'ttsPersistedAnchor', 'ttsStoreLines',
    'ttsStoreLineAnchor', 'ttsMigrateLinesOnEdit', 'ttsPruneLineStore', 'ttsRefreshProviderChat', 'ttsStartChat',
    'ttsPersistLineOverride', 'ttsSaveVoiceMap'];
  vm.runInContext(names.map(section).join('\n'), c);
  return { c, host, calls, chat, bars, timers, setRead: fn => { read = fn; },
    flushTimers: async () => { for (const [id, callback] of [...timers]) { timers.delete(id); await callback(); } } };
}

test('portable reads and missing-cache lookups do not initialize or repair metadata', () => {
  const f = ttsFixture({ unknown: { preserve: true } }), before = structuredClone(f.host);
  assert.equal(f.c.ttsPersistedLines('missing'), null);
  assert.equal(f.c.ttsPersistedAnchor('0'), '');
  assert.equal(Object.keys(f.c.ttsPortableSnapshot().lines).length, 0);
  assert.deepEqual(f.host, before);
  assert.equal(f.calls.store, 0);
  assert.equal(f.calls.save, 0);
});

test('reading an old 100-entry portable cache preserves every stored entry and performs no writes on flush', async () => {
  const lines = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`old-${i}`, line(`台词${i}`)]));
  const anchors = Object.fromEntries(Object.keys(lines).map((key, i) => [String(i), key]));
  const f = ttsFixture({ ttsLines: lines, ttsLineKeyByMes: anchors, ttsLastProvider: 'minimax', future: 'keep' },
    { lines: { local: line('本机台词') }, keyByMes: { local: 'local' } });
  const before = structuredClone(f.host);
  await f.c.ttsPrepareLineStore();
  assert.equal(Object.keys(f.c.ttsLineStoreState.lines).length, 100);
  assert.equal(f.c.ttsPersistedLines('old-0'), lines['old-0']);
  f.c.ttsFlushLocalLineStore(); await f.flushTimers();
  assert.deepEqual(f.host, before);
  assert.equal(f.calls.store, 0);
  assert.equal(f.calls.save, 0);
  assert.equal(f.calls.writes.length, 0);
  assert.equal(f.timers.size, 0);
});

test('an unavailable local cache still reads portable lines without mutation or saving', async () => {
  const f = ttsFixture({ ttsLines: { old: line('既有台词') }, ttsLineKeyByMes: { 0: 'old' } });
  f.setRead(async () => { throw Error('local unavailable'); });
  const before = structuredClone(f.host);
  await f.c.ttsPrepareLineStore();
  assert.equal(f.c.ttsPersistedLines('old')[0].text, '既有台词');
  assert.equal(f.c.ttsLineStoreState.loaded, true);
  assert.deepEqual(f.host, before);
  assert.equal(f.calls.save, 0);
  assert.equal(f.calls.writes.length, 0);
});

test('a delayed local read cannot merge another chat and can be retried on the new owner', async () => {
  for (const sameName of [false, true]) {
    const f = ttsFixture({ ttsLines: { old: line('旧聊天') } }), gate = deferred();
    f.setRead(() => gate.promise);
    const pending = f.c.ttsPrepareLineStore();
    if (!sameName) f.host.chatId = 'chat-B';
    f.host.chatMetadata = { [moduleName]: { ttsLines: { next: line('新聊天') } } };
    const before = structuredClone(f.host);
    gate.resolve({ lines: { late: line('迟到的旧本机记录') } }); await pending;
    assert.equal(f.c.ttsLineStoreState.loaded, false);
    assert.equal(f.c.ttsLineStorePromise, null);
    assert.deepEqual(f.host, before);
    f.setRead(async () => null); await f.c.ttsPrepareLineStore();
    assert.equal(f.c.ttsLineStoreState.lines.next[0].text, '新聊天');
    assert.equal(f.c.ttsLineStoreState.lines.late, undefined);
    assert.equal(f.calls.save, 0);
    assert.equal(f.calls.writes.length, 0);
  }
});

test('disabled inline speech does not prepare, migrate or trim any cache', async () => {
  const f = ttsFixture({ ttsLines: { old: line('原台词') } }), before = structuredClone(f.host);
  f.c.settings.tts.enabled = false;
  f.c.ttsStartChat(); await tick();
  assert.equal(f.calls.stopped, 1);
  assert.equal(f.calls.reads.length, 0);
  assert.equal(f.calls.store, 0);
  assert.equal(f.calls.save, 0);
  assert.deepEqual(f.host, before);
});

test('provider restore uses existing control state and never persists the old provider marker', async () => {
  const f = ttsFixture({ ttsLastProvider: 'minimax', ttsLines: {}, ttsLineKeyByMes: {} });
  f.bars.push({ dataset: { provider: 'minimax' } });
  const before = structuredClone(f.host);
  f.c.ttsStartChat(); await tick();
  assert.equal(f.calls.scans.length, 1);
  assert.equal(f.calls.scans[0].forceProvider, true);
  f.c.ttsRefreshProviderChat(true);
  assert.equal(f.calls.scans.length, 2);
  assert.equal(f.calls.scans[1].expand, true);
  assert.deepEqual(f.host, before);
  assert.equal(f.calls.store, 0);
  assert.equal(f.calls.save, 0);
  assert.equal(f.calls.writes.length, 0);
});

test('provider startup read finishing after metadata replacement does not schedule stale rendering', async () => {
  const f = ttsFixture(), gate = deferred(); f.setRead(() => gate.promise);
  f.c.ttsStartChat(); f.host.chatMetadata = { [moduleName]: {} };
  gate.resolve(null); await tick();
  assert.equal(f.calls.scans.length, 0);
  assert.equal(f.calls.save, 0);
});

test('unchanged dialogue is rebound only in session memory during passive restoration', async () => {
  const oldLines = line('我回来了');
  const f = ttsFixture({ ttsLines: { old: oldLines }, ttsLineKeyByMes: { 0: 'old' } });
  f.host.chat[0].mes = '新的旁白。“我回来了。”';
  const before = structuredClone(f.host);
  await f.c.ttsPrepareLineStore();
  assert.equal(f.c.ttsMigrateLinesOnEdit({}, 'next'), oldLines);
  assert.equal(f.c.ttsPersistedAnchor('0'), 'next');
  f.c.ttsStoreLineAnchor('next', '0'); f.c.ttsFlushLocalLineStore(); await f.flushTimers();
  assert.deepEqual(f.host, before);
  assert.equal(f.calls.store, 0);
  assert.equal(f.calls.save, 0);
  assert.equal(f.calls.writes.length, 0);
  f.host.chat[0].mes = '台词已经改变';
  assert.equal(f.c.ttsMigrateLinesOnEdit({}, 'changed'), null);
});

test('explicit extraction still saves its portable lines and local cache', async () => {
  const f = ttsFixture({ ttsLines: { old: line('旧台词') }, ttsLineKeyByMes: { 0: 'old' }, future: 'keep' });
  await f.c.ttsPrepareLineStore();
  const body = structuredClone(f.host.chat);
  f.c.ttsStoreLines('new', line('明确提取'), '1'); await f.flushTimers();
  assert.equal(f.calls.save, 1);
  assert.equal(f.calls.writes.length, 1);
  assert.equal(f.host.chatMetadata[moduleName].ttsLines.new[0].text, '明确提取');
  assert.equal(f.host.chatMetadata[moduleName].ttsLines.old[0].text, '旧台词');
  assert.equal(f.host.chatMetadata[moduleName].ttsLineKeyByMes[1], 'new');
  assert.equal(f.host.chatMetadata[moduleName].future, 'keep');
  assert.deepEqual(f.host.chat, body);
});

test('explicit speed/emotion edits and voice-map saves retain their persistence', async () => {
  const f = ttsFixture({ ttsLines: { old: line('台词') }, ttsLineKeyByMes: { 0: 'old' } });
  await f.c.ttsPrepareLineStore();
  const element = { querySelector: () => ({ dataset: { key: 'old' } }) };
  assert.equal(f.c.ttsPersistLineOverride(element, 0, { speed: 1.2, emotion: 'happy' }).speed, 1.2);
  assert.equal(f.host.chatMetadata[moduleName].ttsLines.old[0].emotion, 'happy');
  assert.equal(f.calls.save, 1);
  f.c.ttsSaveVoiceMap();
  assert.equal(f.calls.save, 2);
  assert.equal(f.calls.scans.length, 1);
});

function galleryFixture() {
  const message = { mes: '原正文不改变', name: '角色', is_user: false, swipe_id: 0, send_date: '2026-10-19T12:00:00Z' };
  const ref = createStoryboardMessageReference({ message, chatKey: 'chat', floor: 0, now: 1 });
  const records = [{ id: 'modern', chatKey: 'chat', floor: 0, messageRef: ref, url: '/image.png', future: { keep: true } },
    { id: 'legacy', chatKey: 'chat', floor: 1, messageHash: hashText(message.mes), url: '/legacy.png' },
    { id: 'review', floor: null, restoreLinkReview: { version: 1 } }];
  const host = { chatId: 'chat', chat: [{ mes: '前置消息' }, message], chatMetadata: { [moduleName]: { storyboardImages: records } } };
  const calls = { save: 0, queued: 0, deleted: [] };
  const c = vm.createContext({ console, Array, Object, String, Number, Map, Set,
    createStoryboardMessageReference, resolveStoryboardMessageReference, hashText,
    MODULE_NAME: moduleName, ctx: () => host, getChatKey: () => host.chatId,
    getChatStore: () => host.chatMetadata[moduleName], storyboardGalleryRecords: () => host.chatMetadata[moduleName].storyboardImages,
    storyboardRecordChatKey: record => record.chatKey || 'chat',
    queueMicrotask: () => { calls.queued++; }, saveMetadata: async () => { calls.save++; },
    storyboardScheduleLinkSave: () => { calls.queued++; }, storyboardAdmissionEpoch: 1,
    storyboardGallerySelection: new Set(), confirmDialog: async () => true,
    storyboardDeleteRecordSnapshots: async record => calls.deleted.push(record.id),
    storyboardRenderInlineImages() {}, rerenderIfOpen() {},
  });
  vm.runInContext(['storyboardRecoverLegacyMessageReference', 'storyboardReconcileGalleryLinks', 'storyboardRemoveImage'].map(section).join('\n'), c);
  return { c, host, records, calls };
}

test('ordinary gallery link derivation keeps relocation working without queuing any chat save', async () => {
  const f = galleryFixture(), body = structuredClone(f.host.chat), review = structuredClone(f.records[2]);
  assert.equal(f.c.storyboardReconcileGalleryLinks(), true);
  assert.equal(f.records[0].floor, 1);
  assert.equal(f.records[0].linkState, 'active');
  assert.ok(f.records[1].messageRef.messageKey);
  assert.deepEqual(f.records[2], review);
  assert.deepEqual(f.records[0].future, { keep: true });
  assert.equal(f.records[0].url, '/image.png');
  assert.equal(f.c.storyboardReconcileGalleryLinks(), false);
  await tick();
  assert.equal(f.calls.queued, 0);
  assert.equal(f.calls.save, 0);
  assert.deepEqual(f.host.chat, body);
});

test('explicit confirmed gallery deletion still performs its own save and preserves unrelated records', async () => {
  const f = galleryFixture(), body = structuredClone(f.host.chat), untouched = structuredClone(f.records.slice(1));
  await f.c.storyboardRemoveImage(f.records[0]);
  assert.equal(f.calls.save, 1);
  assert.deepEqual(f.host.chatMetadata[moduleName].storyboardImages, untouched);
  assert.deepEqual(f.calls.deleted, ['modern']);
  assert.deepEqual(f.host.chat, body);
});

function synthesisFixture(kind = 'map') {
  const entry = { id: 'voice-entry', name: '角色', voiceId: 'voice-1', model: 'auto' };
  const rows = [entry], provider = { voiceLibrary: kind === 'library' ? rows : [], npcArchetypes: kind === 'npc' ? rows : [] };
  const f = ttsFixture({ ttsVoiceMaps: { doubao: rows }, ttsLines: {}, ttsLineKeyByMes: {} });
  f.c.settings.tts.providers = { doubao: provider };
  const gate = deferred(), blob = { synthetic: true };
  Object.assign(f.c, {
    ttsRestoreTasks: 0, ttsProviderConfig: () => provider,
    ttsActiveVoiceMap: () => { f.calls.store++; return f.host.chatMetadata[moduleName].ttsVoiceMaps.doubao; },
    ttsBuildParams: () => ({ providerId: 'doubao', model: 'auto', voiceId: 'voice-1',
      voiceSourceType: kind, voiceSourceId: kind === 'map' ? '角色' : 'voice-entry' }),
    getTtsProvider: () => ({ label: 'synthetic' }), ttsProviderHasCredentials: () => true,
    ttsDoubaoVoiceModel: value => value, cacheKeyForTts: (_id, params) => params.model,
    synthesizeTts: () => gate.promise,
    blobStore: { blobStoreAvailable: () => false },
  });
  vm.runInContext(['ttsCaptureResolvedModelOwner', 'ttsPersistResolvedDoubaoModel', 'ttsSynthCached'].map(section).join('\n'), f.c);
  return { ...f, entry, rows, provider, blob, finish: () => gate.resolve({ blob, resolvedModel: 'resolved-model' }) };
}

for (const mutation of ['chat-switch', 'metadata-replaced', 'chat-array-replaced', 'map-replaced', 'entry-replaced', 'entry-edited']) {
  test(`late resolved voice model ${mutation}: returns audio but does not touch the newly selected map`, async () => {
    const f = synthesisFixture(), task = f.c.ttsSynthCached({ speaker: '角色' }, true);
    const replacement = { id: 'voice-entry', name: '角色', voiceId: 'voice-1', model: 'auto' };
    if (mutation === 'chat-switch') {
      f.host.chatId = 'chat-B';
      f.host.chatMetadata = { [moduleName]: { ttsVoiceMaps: { doubao: [replacement] } } };
    }
    if (mutation === 'metadata-replaced') f.host.chatMetadata = { [moduleName]: { ttsVoiceMaps: { doubao: [replacement] } } };
    if (mutation === 'chat-array-replaced') f.host.chat = [...f.host.chat];
    if (mutation === 'map-replaced') f.host.chatMetadata[moduleName].ttsVoiceMaps.doubao = [replacement];
    if (mutation === 'entry-replaced') f.rows[0] = replacement;
    if (mutation === 'entry-edited') f.entry.model = 'user-choice';
    const before = structuredClone(f.host), reads = f.calls.store;
    f.finish(); const result = await task;
    assert.equal(result.blob, f.blob);
    assert.equal(result.params.model, 'resolved-model');
    assert.deepEqual(f.host, before);
    assert.equal(f.calls.store, reads, 'stale resolution must not consult the new live map');
    assert.equal(f.calls.save, 0);
    assert.equal(f.calls.settings, 0);
    assert.equal(f.c.ttsRestoreTasks, 0);
  });
}

for (const kind of ['map', 'library', 'npc']) {
  test(`same ${kind} owner still remembers the resolved model exactly once`, async () => {
    const f = synthesisFixture(kind), task = f.c.ttsSynthCached({ speaker: '角色' }, true);
    f.finish(); const result = await task;
    assert.equal(result.blob, f.blob);
    assert.equal(f.entry.model, 'resolved-model');
    assert.equal(f.calls.save, kind === 'map' ? 1 : 0);
    assert.equal(f.calls.settings, kind === 'map' ? 0 : 1);
  });
}

for (const kind of ['library', 'npc']) {
  for (const mutation of ['settings-replaced', 'provider-replaced', 'array-replaced', 'entry-replaced', 'entry-edited']) {
    test(`global ${kind} ${mutation}: old audio completion cannot overwrite later settings`, async () => {
      const f = synthesisFixture(kind), task = f.c.ttsSynthCached({ speaker: '角色' }, true);
      const replacement = { ...f.entry }, field = kind === 'library' ? 'voiceLibrary' : 'npcArchetypes';
      if (mutation === 'settings-replaced') f.c.settings = structuredClone(f.c.settings);
      if (mutation === 'provider-replaced') f.c.settings.tts.providers.doubao = structuredClone(f.provider);
      if (mutation === 'array-replaced') f.provider[field] = [replacement];
      if (mutation === 'entry-replaced') f.rows[0] = replacement;
      if (mutation === 'entry-edited') f.entry.voiceId = 'user-new-voice';
      const before = structuredClone(f.c.settings), old = structuredClone(f.provider);
      f.finish(); const result = await task;
      assert.equal(result.blob, f.blob);
      assert.deepEqual(f.c.settings, before);
      assert.deepEqual(f.provider, old);
      assert.equal(f.calls.save, 0);
      assert.equal(f.calls.settings, 0);
    });
  }
}
