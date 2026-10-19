import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

function fixture({ worldScannedAt = '', failWorld = false } = {}) {
  const calls = { presets: 0, worlds: 0, renders: 0, errors: 0, saves: 0 };
  const cache = { presets: {}, worldBooks: {}, presetNames: [], worldBookNames: [], presetScannedAt: '', worldScannedAt };
  const sandbox = vm.createContext({
    contextScanCache: cache, contextRefreshPromise: null, presetRefreshPromise: null,
    contextWorldEpoch: 0, contextWorldPreviewRevision: 0, lastWorldView: '', getChatKey: () => 'chat-A',
    contextAutoScanned: false, activeTab: 'context', MODULE_NAME: 'test', MODAL_ID: 'test-modal',
    settings: { contextOptions: {} },
    document: { getElementById: () => ({ classList: { contains: () => true } }) },
    getCurrentPresetName: () => 'Current',
    listPresetNames: () => { calls.presets++; return ['Current', 'Other']; },
    getSelectedPresetNames: () => ['Current'], getPresetEntries: () => [{ content: 'saved prompt' }],
    detectBoundWorldBookNames: () => ['Book'], getSelectedWorldBookNames: () => ['Book'],
    listWorldBooks: async () => { calls.worlds++; if (failWorld) throw new Error('unavailable'); return ['Book']; },
    getWorldBookEntries: async () => [{ content: 'world entry' }],
    initializeSelectedContextState() {}, saveSettings: () => { calls.saves++; }, toast() {},
    console: { warn: () => { calls.errors++; } },
    getCharacterName: () => 'Character', getPersonaName: () => 'User',
    infoTag: value => value, htmlEscape: value => String(value),
    renderTagRules: () => '', renderPresetSourcePanel: () => '', renderWorldBookSourcePanel: () => '',
    renderModal() {
      calls.renders++;
      // Bound the old recursion so a regression fails without exhausting the process stack.
      if (calls.renders > 12) throw new Error('recursive render');
      if (sandbox.activeTab === 'context') sandbox.renderContextTab();
      if (sandbox.activeTab === 'theater') sandbox.requestPresetRefreshIfStale();
    },
  });
  const names = ['rerenderIfOpen', 'refreshPresets', 'contextWorldReadCurrent', 'invalidateContextWorldCache', 'ensureContextWorldBook', 'previewContextWorldBook', 'refreshWorldBooks', 'refreshContextSources',
    'requestPresetRefreshIfStale', 'requestContextRefreshIfStale', 'maybeAutoScanContext', 'renderContextTab'];
  vm.runInContext(names.map(storyboardFunctionSource).join('\n'), sandbox);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await Promise.all([sandbox.contextRefreshPromise, sandbox.presetRefreshPromise]);
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  return { sandbox, calls, cache, settle };
}

test('first materials render schedules one scan without synchronous render reentry', async () => {
  const f = fixture();
  const html = f.sandbox.renderContextTab();
  assert.match(html, /<em>CHAR<\/em>/);
  assert.equal(f.calls.presets, 0, 'register the in-flight guard before scanning');
  assert.equal(f.calls.renders, 0, 'the initial render must return before any refresh repaint');
  await f.settle();
  assert.equal(f.calls.presets, 1);
  assert.equal(f.calls.worlds, 1);
  assert.equal(f.calls.errors, 0);
  assert.ok(f.cache.worldScannedAt);
  assert.equal(f.sandbox.contextRefreshPromise, null);
});

test('an expired world cache cannot recursively restart a context refresh', async () => {
  const f = fixture({ worldScannedAt: '2000-01-01T00:00:00.000Z' });
  f.cache.presetScannedAt = new Date().toISOString();
  f.sandbox.requestContextRefreshIfStale(0);
  await f.settle();
  assert.equal(f.calls.presets, 1);
  assert.equal(f.calls.worlds, 1);
  assert.equal(f.calls.errors, 0);
  assert.equal(f.calls.renders, 2);
});

test('switching from an in-flight theater refresh to materials still reads world books', async () => {
  const f = fixture();
  f.sandbox.activeTab = 'theater';
  f.sandbox.requestPresetRefreshIfStale(0);
  f.sandbox.activeTab = 'context';
  f.sandbox.requestContextRefreshIfStale(0);
  f.sandbox.renderContextTab();
  await f.settle();
  assert.equal(f.calls.presets, 1);
  assert.equal(f.calls.worlds, 1);
  assert.equal(f.calls.errors, 0);
  assert.ok(f.cache.worldScannedAt);
});

test('theater-only refresh stays preset-only and merges repeated renders', async () => {
  const f = fixture();
  f.sandbox.activeTab = 'theater';
  const pending = f.sandbox.requestPresetRefreshIfStale(0);
  for (let i = 0; i < 20; i++) assert.equal(f.sandbox.requestPresetRefreshIfStale(0), pending);
  assert.equal(f.calls.presets, 0);
  await f.settle();
  assert.equal(f.calls.presets, 1);
  assert.equal(f.calls.worlds, 0);
  assert.equal(f.calls.renders, 1);
  assert.equal(f.sandbox.presetRefreshPromise, null);
});

test('slow world reads keep both refresh entry points guarded across tab switches', async () => {
  const f = fixture();
  let releaseWorld;
  f.sandbox.listWorldBooks = () => {
    f.calls.worlds++;
    return new Promise(resolve => { releaseWorld = () => resolve(['Book']); });
  };
  const pending = f.sandbox.requestContextRefreshIfStale(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.worlds, 1);
  for (let i = 0; i < 20; i++) {
    f.sandbox.activeTab = 'theater';
    assert.equal(f.sandbox.requestPresetRefreshIfStale(0), pending);
    f.sandbox.activeTab = 'context';
    assert.equal(f.sandbox.requestContextRefreshIfStale(0), pending);
    f.sandbox.renderContextTab();
  }
  releaseWorld();
  await f.settle();
  assert.equal(f.calls.presets, 1);
  assert.equal(f.calls.worlds, 1);
  assert.equal(f.calls.errors, 0);
  assert.equal(f.calls.renders, 2);
});

test('a failed world read stops without repaint/retry loops and can retry on next entry', async () => {
  const f = fixture({ failWorld: true });
  f.sandbox.renderContextTab();
  await f.settle();
  assert.equal(f.calls.presets, 1);
  assert.equal(f.calls.worlds, 1);
  assert.equal(f.calls.renders, 1);
  assert.equal(f.calls.errors, 1);
  assert.equal(f.sandbox.contextRefreshPromise, null);
  f.sandbox.listWorldBooks = async () => { f.calls.worlds++; return ['Book']; };
  f.sandbox.requestContextRefreshIfStale(0);
  await f.settle();
  assert.equal(f.calls.worlds, 2);
  assert.ok(f.cache.worldScannedAt);
  assert.equal(f.calls.errors, 1);
});

test('a failed preset read releases its guard and permits a later refresh', async () => {
  const f = fixture();
  f.sandbox.activeTab = 'theater';
  f.sandbox.listPresetNames = () => { f.calls.presets++; throw new Error('unavailable'); };
  f.sandbox.requestPresetRefreshIfStale(0);
  await f.settle();
  assert.equal(f.calls.presets, 1);
  assert.equal(f.calls.errors, 1);
  assert.equal(f.calls.renders, 0);
  assert.equal(f.sandbox.presetRefreshPromise, null);
  f.sandbox.listPresetNames = () => { f.calls.presets++; return ['Current', 'New']; };
  f.sandbox.requestPresetRefreshIfStale(0);
  await f.settle();
  assert.equal(f.calls.presets, 2);
  assert.deepEqual([...f.cache.presetNames], ['Current', 'New']);
});

test('fresh renders reuse cached data but reentering materials refreshes the inventory', async () => {
  const f = fixture();
  f.sandbox.renderContextTab();
  await f.settle();
  for (let i = 0; i < 20; i++) f.sandbox.renderContextTab();
  await f.settle();
  assert.equal(f.calls.presets, 1);
  assert.equal(f.calls.worlds, 1);
  f.sandbox.listPresetNames = () => { f.calls.presets++; return ['Current', 'New']; };
  f.sandbox.requestContextRefreshIfStale(0);
  await f.settle();
  assert.equal(f.calls.presets, 2);
  assert.equal(f.calls.worlds, 2);
  assert.deepEqual([...f.cache.presetNames], ['Current', 'New']);
});

test('directory refresh retains an unselected book opened for preview without selecting it', async () => {
  const f = fixture();
  f.sandbox.getSelectedWorldBookNames = () => [];
  f.sandbox.lastWorldView = 'Book';
  f.cache.worldBooks.Book = [{ content: 'previewed world entry' }];
  await f.sandbox.refreshWorldBooks(false);
  assert.ok(f.cache.worldBooks.Book?.length, 'refresh must not turn an unselected preview into an empty book');
  assert.deepEqual(f.sandbox.getSelectedWorldBookNames(), []);
});

test('an old directory read cannot populate or initialize another chat', async () => {
  const f = fixture();
  let chat = 'chat-A', release;
  f.sandbox.getChatKey = () => chat;
  f.sandbox.listWorldBooks = () => new Promise(resolve => { release = resolve; });
  const pending = f.sandbox.refreshWorldBooks(false);
  chat = 'chat-B';
  f.cache.worldBooks = { New: [{ content: 'new chat view' }] };
  f.cache.worldBookNames = ['New'];
  release(['Book']); await pending;
  assert.deepEqual([...f.cache.worldBookNames], ['New']);
  assert.equal(f.cache.worldBooks.Book, undefined);
  assert.equal(f.calls.saves, 0);
});

test('chat invalidation clears only ephemeral world view and old finally cannot release the new refresh guard', async () => {
  const f = fixture(), releases = [];
  f.sandbox.listWorldBooks = () => new Promise(resolve => releases.push(resolve));
  const old = f.sandbox.requestContextRefreshIfStale(0);
  await new Promise(resolve => setImmediate(resolve));
  f.sandbox.lastWorldView = 'Book'; f.cache.worldBooks.Book = [{ content: 'old' }];
  f.sandbox.invalidateContextWorldCache();
  assert.equal(f.sandbox.lastWorldView, ''); assert.deepEqual(Object.keys(f.cache.worldBooks), []);
  assert.deepEqual([...f.cache.worldBookNames], []); assert.equal(f.cache.worldScannedAt, '');
  const current = f.sandbox.requestContextRefreshIfStale(0);
  await new Promise(resolve => setImmediate(resolve));
  releases[0](['Old']); await old;
  assert.equal(f.sandbox.contextRefreshPromise, current);
  releases[1](['Book']); await current;
  assert.deepEqual([...f.cache.worldBookNames], ['Book']);
  assert.equal(f.sandbox.contextRefreshPromise, null);
});

test('unselected previews remain read-only and the latest clicked book wins out-of-order responses', async () => {
  const f = fixture(), releases = {};
  f.sandbox.renderModal = () => { f.calls.renders++; };
  f.sandbox.getSelectedWorldBookNames = () => [];
  f.sandbox.getWorldBookEntries = name => new Promise(resolve => { releases[name] = resolve; });
  const first = f.sandbox.previewContextWorldBook('First');
  const second = f.sandbox.previewContextWorldBook('Second');
  releases.Second([{ content: 'second' }]); await second;
  releases.First([{ content: 'first' }]); await first;
  assert.equal(f.sandbox.lastWorldView, 'Second'); assert.equal(f.calls.renders, 1);
  assert.equal(f.calls.saves, 0);
  assert.deepEqual(f.sandbox.getSelectedWorldBookNames(), []);
});

test('late preview success or failure after leaving a chat cannot restore its view or cache', async () => {
  for (const fail of [false, true]) {
    const f = fixture(); let complete;
    f.sandbox.renderModal = () => { f.calls.renders++; };
    f.sandbox.getWorldBookEntries = () => new Promise((resolve, reject) => { complete = () => fail ? reject(Error('read failed')) : resolve([{ content: 'old' }]); });
    const pending = f.sandbox.previewContextWorldBook('Book');
    f.sandbox.invalidateContextWorldCache(); complete(); await pending;
    assert.equal(f.sandbox.lastWorldView, ''); assert.deepEqual(Object.keys(f.cache.worldBooks), []);
    assert.equal(f.calls.renders, 0); assert.equal(f.calls.saves, 0);
  }
});

test('a preview completed during a directory refresh is not erased when only selected books finish later', async () => {
  const f = fixture(); let finishSelected;
  f.sandbox.renderModal = () => { f.calls.renders++; };
  f.sandbox.listWorldBooks = async () => ['Book', 'Preview'];
  f.sandbox.getWorldBookEntries = name => name === 'Book' ? new Promise(resolve => { finishSelected = resolve; }) : Promise.resolve([{ content: 'preview' }]);
  const refresh = f.sandbox.refreshWorldBooks(false);
  await new Promise(resolve => setImmediate(resolve));
  await f.sandbox.previewContextWorldBook('Preview');
  finishSelected([{ content: 'selected' }]); await refresh;
  assert.equal(f.cache.worldBooks.Preview[0].content, 'preview');
  assert.equal(f.sandbox.lastWorldView, 'Preview');
});

test('a late refresh of the same book cannot overwrite a newer clicked preview', async () => {
  const f = fixture(), releases = [];
  f.sandbox.renderModal = () => { f.calls.renders++; };
  f.sandbox.getWorldBookEntries = () => new Promise(resolve => releases.push(resolve));
  const refresh = f.sandbox.refreshWorldBooks(false);
  await new Promise(resolve => setImmediate(resolve));
  const preview = f.sandbox.previewContextWorldBook('Book');
  releases[1]([{ content: 'newer clicked preview' }]); await preview;
  releases[0]([{ content: 'older refresh response' }]); await refresh;
  assert.equal(f.cache.worldBooks.Book[0].content, 'newer clicked preview');
});
