import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogBodiesSidecar } from '../qianmu-log-bodies-sidecar.js';
import { attachSettingsPersistence } from '../qianmu-settings-persistence.js';

function fakeIndexedDB({ failing = false } = {}) {
  const databases = new Map();
  return { databases, open(name) {
    const request = {};
    if (!databases.has(name)) databases.set(name, new Map());
    const rows = databases.get(name);
    const db = { objectStoreNames: { contains: () => true }, createObjectStore() {}, close() {},
      transaction() {
        const tx = {};
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => (failing ? tx.onerror?.() : tx.oncomplete?.()))));
        tx.objectStore = () => ({
          get(key) { const r = {}; queueMicrotask(() => { r.result = rows.get(key); r.onsuccess?.(); }); return r; },
          put(value) { if (!failing) rows.set(value.id, structuredClone(value)); return {}; },
          delete(key) { rows.delete(key); },
          openKeyCursor() {
            const cursor = {}, keys = [...rows.keys()]; let index = 0;
            const step = () => queueMicrotask(() => { cursor.result = index < keys.length ? { key: keys[index], continue() { index++; step(); } } : null; cursor.onsuccess?.(); });
            step(); return cursor;
          },
        });
        return tx;
      } };
    queueMicrotask(() => { request.result = db; request.onsuccess?.(); });
    return request;
  } };
}
function fixture(options = {}) {
  const idb = options.indexedDB || fakeIndexedDB(options), timers = []; let saves = 0, restoredCalls = 0;
  const sidecar = createLogBodiesSidecar({ resolveNamespace: async () => 'st-user:test', indexedDB: idb, requestSave: () => { saves++; }, onRestored: () => { restoredCalls++; },
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, cancel: () => {} });
  const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };
  const runTimers = async () => { for (const timer of timers.splice(0)) timer.fn(); await settle(); await sidecar.flush(); await settle(); };
  const hooks = { slimmers: [sidecar.slimmer], restorers: [settings => sidecar.restore(settings)] };
  return { sidecar, idb, timers, settle, runTimers, hooks, get saves() { return saves; }, get restoredCalls() { return restoredCalls; } };
}
const log = (id, status = 'success', size = 5000) => ({ id, status, time: '12:00', duration: '3s', request: `请求 ${id} ` + '甲'.repeat(size), response: `回复 ${id} ` + '乙'.repeat(size), error: '' });
const save = settings => JSON.parse(JSON.stringify(settings));

test('finished logs are written in full until stored in this browser, then shortened; memory never changes', async () => {
  const f = fixture(), logs = [log('a'), log('b'), log('run', 'loading'), log('small', 'success', 100)];
  const settings = attachSettingsPersistence({ logHistory: logs }, f.hooks);
  const full = JSON.stringify(logs);
  assert.deepEqual(save(settings).logHistory, JSON.parse(full), 'first save is complete');
  await f.runTimers();
  assert.equal(f.saves, 1, 'a follow-up save is requested once the texts are stored');
  const written = save(settings).logHistory;
  for (const id of ['a', 'b']) {
    const entry = written.find(item => item.id === id), original = logs.find(item => item.id === id);
    assert.equal(entry.bodyStored, true);
    assert.ok(entry.request.length < 1700 && entry.request.startsWith(original.request.slice(0, 1500)) && entry.request.includes('完整内容保存在产生这条日志的浏览器里'));
    assert.equal(entry.status, 'success'); assert.equal(entry.duration, '3s');
  }
  assert.deepEqual(written.find(item => item.id === 'run'), JSON.parse(full)[2], 'a running log is always written in full');
  assert.deepEqual(written.find(item => item.id === 'small'), JSON.parse(full)[3], 'small logs are left alone');
  assert.equal(JSON.stringify(settings.logHistory), full, 'memory is untouched');
  assert.ok(JSON.stringify(written).length < full.length * 0.75);
});

test('a reload restores the full text in this browser; elsewhere the shortened text with its note remains and is never re-shortened', async () => {
  const f = fixture(), logs = [log('a'), log('b')];
  const settings = attachSettingsPersistence({ logHistory: logs }, f.hooks);
  save(settings); await f.runTimers();
  const persisted = save(settings);

  const same = fixture({ indexedDB: f.idb }), reloaded = structuredClone(persisted);
  attachSettingsPersistence(reloaded, same.hooks); await same.settle();
  assert.deepEqual(reloaded.logHistory, logs); assert.equal(same.restoredCalls, 1, 'the open panel is told once');
  assert.deepEqual(save(reloaded).logHistory, persisted.logHistory, 'restored logs are known as stored: the next save is short again');

  const elsewhere = fixture(), other = structuredClone(persisted);
  attachSettingsPersistence(other, elsewhere.hooks); await elsewhere.settle();
  assert.deepEqual(other.logHistory, persisted.logHistory, 'no full text here');
  assert.deepEqual(save(other).logHistory, persisted.logHistory, 'and it is written back unchanged');
  assert.equal(elsewhere.timers.length, 0, 'a shortened log is never stored as if it were the full text');
});

test('a log that changes is stored again before it is shortened; removed logs are forgotten; a failing store keeps everything in full', async () => {
  const f = fixture(), entry = log('a'), settings = attachSettingsPersistence({ logHistory: [entry, log('old')] }, f.hooks);
  save(settings); await f.runTimers();
  entry.response += '（续写）';
  assert.equal(save(settings).logHistory[0].response, entry.response, 'changed text is written in full until stored again');
  await f.runTimers();
  assert.equal(save(settings).logHistory[0].bodyStored, true);
  const rows = f.idb.databases.get('qianmu-request-logs::st-user:test');
  assert.equal(rows.get('a').response, entry.response);
  settings.logHistory = [entry, log('new')]; save(settings); await f.runTimers();
  assert.deepEqual([...rows.keys()].sort(), ['a', 'new'], 'the entry that left the list is deleted from the browser store');

  const broken = fixture({ failing: true }), other = attachSettingsPersistence({ logHistory: [log('x')] }, broken.hooks);
  const warn = console.warn; console.warn = () => {};
  try { save(other); await broken.runTimers(); } finally { console.warn = warn; }
  assert.equal(save(other).logHistory[0].bodyStored, undefined); assert.equal(broken.saves, 0);
});
