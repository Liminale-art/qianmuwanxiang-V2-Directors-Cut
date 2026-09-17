// Actual film deletion wrapper, store adapter and native IndexedDB on a fresh
// isolated origin. Only synthetic records are created/removed. No ST data or media.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), errors = [], checks = [];
let external = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<main id="modal" class="open"><div class="sd-storyboard-film-page"></div></main>' });
  if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8') });
  external++; return route.abort();
});
try {
  await page.goto('https://qianmu.test/');
  await page.evaluate(async source => {
    window.storage = await import('/qianmu-blobstore.js');
    window.timelineModule = await import('/qianmu-video-timeline.js');
    window.postModule = await import('/qianmu-video-postproduction.js');
    const adapter = await import('/qianmu-video-timeline-store.js');
    window.store = adapter.createVideoTimelineStoreAdapter(storage);
    Object.assign(window, await import('/qianmu-film-editor-save.js'));
    Object.assign(window, { settings: {}, storyboardAdmissionEpoch: 1, MODAL_ID: 'modal', currentChat: 'a', renders: 0, notices: [], storyboardFilmEditor: null });
    window.getChatKey = () => currentChat;
    window.renderModal = () => { renders++; };
    window.toast = (text, level) => notices.push({ text, level });
    window.storyboardEnsureFilmRuntime = async () => ({ store });
    window.confirmDialog = async () => true;
    (0, eval)(source);
    window.raw = async (name, key, value) => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('qianmu-blobstore'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(name, value === undefined ? 'readonly' : 'readwrite');
          const r = value === undefined ? tx.objectStore(name).get(key) : tx.objectStore(name).put(value, key);
          tx.oncomplete = () => resolve(r.result); tx.onabort = tx.onerror = () => reject(tx.error);
        });
      } finally { db.close(); }
    };
    window.seed = async id => {
      const built = timelineModule.buildVideoTimeline({ timelineId: id, title: id, owner: { chatKey: 'a' },
        stillRecords: [{ id: 'still', chatKey: 'a', floor: 2 }], selections: [{ kind: 'still', recordId: 'still', clipId: 'clip', durationSeconds: 3 }] }, { now: 1000 });
      if (!built.ok) throw Error(JSON.stringify(built.issues));
      const film = await store.save(built.timeline, { now: 1000 });
      const project = postModule.normalizeVideoPostproduction({ mode: 'native_only' }, film);
      await storage.putVideoPostproduction(project);
      window.storyboardFilmRuntime = { timelines: [film] }; currentChat = 'a'; notices = []; renders = 0;
      document.getElementById('modal').classList.add('open');
      document.getElementById('modal').innerHTML = '<div class="sd-storyboard-film-page"></div>';
      confirmDialog = async () => true;
      return film;
    };
    await seed('init');
    for (const name of ['video_media', 'audio', 'reader_images']) await raw(name, 'original', { marker: name });
  }, storyboardFunctionSource('storyboardDeleteFilmTimeline'));

  for (const mode of ['success', 'cancel', 'chat', 'account', 'epoch', 'close', 'page', 'revision', 'stored-revision', 'post-owner', 'atomic-abort']) {
    const result = await page.evaluate(async mode => {
      const film = await seed('case-' + mode);
      if (mode === 'cancel') confirmDialog = async () => false;
      if (mode === 'stored-revision') await store.save({ ...film, title: 'newer stored revision' }, { now: 2000 });
      if (mode === 'post-owner') {
        const post = await raw('video_postproduction', film.timelineId);
        post.chatKey = 'b'; post.project.owner.chatKey = 'b'; await raw('video_postproduction', film.timelineId, post);
      }
      if (['chat', 'account', 'epoch', 'close', 'page', 'revision'].includes(mode)) confirmDialog = async () => {
        if (mode === 'chat') currentChat = 'b';
        if (mode === 'account') settings = {};
        if (mode === 'epoch') storyboardAdmissionEpoch++;
        if (mode === 'close') document.getElementById('modal').classList.remove('open');
        if (mode === 'page') document.querySelector('.sd-storyboard-film-page').remove();
        if (mode === 'revision') storyboardFilmRuntime.timelines = [{ ...film, updatedAt: 2000 }];
        return true;
      };
      const originalDelete = IDBObjectStore.prototype.delete;
      if (mode === 'atomic-abort') IDBObjectStore.prototype.delete = function (key) {
        if (this.name === 'video_postproduction') throw new DOMException('Synthetic second-delete failure', 'AbortError');
        return originalDelete.call(this, key);
      };
      try { await storyboardDeleteFilmTimeline(film.timelineId); }
      finally { IDBObjectStore.prototype.delete = originalDelete; }
      return { timeline: Boolean(await raw('video_timelines', film.timelineId)), post: Boolean(await raw('video_postproduction', film.timelineId)),
        notices, renders, locked: isFilmEditorSaving(film) };
    }, mode);
    assert.equal(result.timeline, mode !== 'success', JSON.stringify({ mode, result }));
    assert.equal(result.post, mode !== 'success', JSON.stringify({ mode, result }));
    assert.equal(result.locked, false);
    if (mode === 'atomic-abort') assert.match(result.notices.at(-1).text, /删除失败.*仍保留/);
    checks.push(`${mode}: native two-store outcome and released lock`);
  }
  const guard = await page.evaluate(async () => {
    const film = await seed('late-guard'); let calls = 0;
    const result = await storage.deleteVideoTimelineSnapshot(film, { guard: () => ++calls < 2 });
    return { result, calls, retained: Boolean(await raw('video_timelines', film.timelineId)) && Boolean(await raw('video_postproduction', film.timelineId)) };
  });
  assert.deepEqual(guard.result.deleted, []); assert.equal(guard.retained, true); assert.equal(guard.calls, 2);
  checks.push('owner rechecked inside native transaction before either deletion');
  const absent = await page.evaluate(async () => {
    const film = await seed('without-sidecar'); await storage.deleteVideoPostproduction([film.timelineId]);
    return (await store.removeIfUnchanged(film, { guard: () => true })).deleted;
  });
  assert.deepEqual(absent, ['without-sidecar']); checks.push('legacy timeline without a sidecar remains deletable');
  const repeat = await page.evaluate(async () => {
    const film = await seed('duplicate'); let release;
    confirmDialog = () => new Promise(r => { release = r; });
    const first = storyboardDeleteFilmTimeline(film.timelineId);
    await storyboardDeleteFilmTimeline(film.timelineId);
    const busy = notices.some(item => /正在保存或删除/.test(item.text)); release(true); await first;
    return { busy, exists: Boolean(await raw('video_timelines', film.timelineId)) };
  });
  assert.deepEqual(repeat, { busy: true, exists: false }); checks.push('duplicate real wrapper call shares one mutation');
  const originals = await page.evaluate(async () => Promise.all(['video_media', 'audio', 'reader_images'].map(async name => (await raw(name, 'original'))?.marker === name)));
  assert.deepEqual(originals, [true, true, true]); checks.push('video audio and image originals remain untouched');
  assert.deepEqual(errors, []); assert.equal(external, 0);
  console.log(JSON.stringify({ passed: checks.length, checks, errors, external, productionDataRead: false, scope: 'actual wrapper/adapter/native IndexedDB with synthetic records; no real account or disk-failure claim' }));
} finally { await context.close(); await browser.close(); }
