import test from 'node:test';
import assert from 'node:assert/strict';
import { createFontLocalStore } from '../qianmu-font-local-store.js';

function fakeIdb({ abortWrites = false } = {}) {
  const databases = new Map(), opens = [], operations = [];
  return { opens, operations, open(name) {
    opens.push(name); const request = {};
    queueMicrotask(() => {
      const entries = databases.get(name) || new Map(); databases.set(name, entries);
      const database = {
        objectStoreNames: { contains: () => true }, close() {},
        transaction(storeName, mode) {
          operations.push([storeName, mode]); const tx = {}, changes = [];
          let aborted = false;
          tx.objectStore = () => ({
            put(value, id) { changes.push(() => entries.set(id, value)); },
            delete(id) { changes.push(() => entries.delete(id)); },
            get(id) { const result = {}; queueMicrotask(() => { result.result = entries.get(id); result.onsuccess?.(); }); return result; },
          });
          tx.abort = () => { aborted = true; tx.onabort?.(); };
          setImmediate(() => {
            if (aborted) return;
            if (abortWrites && mode === 'readwrite') tx.onabort?.();
            else { changes.forEach((change) => change()); tx.oncomplete?.(); }
          });
          return tx;
        },
      };
      request.result = database; request.onsuccess?.();
    });
    return request;
  } };
}

test('local font bytes are account-namespaced; no metadata or chat writes', async () => {
  const indexedDB = fakeIdb();
  const alice = createFontLocalStore({ namespace: 'alice', indexedDB });
  const bob = createFontLocalStore({ namespace: 'bob', indexedDB });
  await alice.put('font1', new Uint8Array([1, 2, 3]), 'font/woff2');
  assert.equal(await bob.get('font1'), null);
  const blob = await alice.get('font1');
  assert.equal(blob.type, 'font/woff2'); assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
  assert.deepEqual(indexedDB.opens, ['qianmu-fonts:alice', 'qianmu-fonts:bob']);
  assert.ok(indexedDB.operations.every(([name]) => name === 'fonts'));
  alice.dispose(); bob.dispose();
});

test('delete removes only explicit IDs and duplicate IDs are harmless', async () => {
  const indexedDB = fakeIdb(), store = createFontLocalStore({ namespace: 'a', indexedDB });
  await store.put('one', new Uint8Array([1])); await store.put('two', new Uint8Array([2]));
  await store.delete(['one', 'one']); assert.equal(await store.get('one'), null); assert.ok(await store.get('two'));
  store.dispose();
});

test('write success requires transaction completion, abort is never reported saved', async () => {
  const store = createFontLocalStore({ namespace: 'a', indexedDB: fakeIdb({ abortWrites: true }) });
  await assert.rejects(store.put('one', new Uint8Array([1])), /未保存/);
  store.dispose();
});

test('account, availability, bytes and closed-store errors never silently fallback', async () => {
  assert.throws(() => createFontLocalStore({ namespace: '' }), /账户/);
  const unsupported = createFontLocalStore({ namespace: 'a', indexedDB: null });
  await assert.rejects(unsupported.put('one', new Uint8Array([1])), /Web 引用/);
  const store = createFontLocalStore({ namespace: 'a', indexedDB: fakeIdb() });
  await assert.rejects(store.put('one', {}), /无效/);
  await assert.rejects(store.put('one', new Uint8Array()), /为空/);
  store.dispose(); await assert.rejects(store.get('one'), /已关闭/);
});

test('account disposal aborts an unfinished transaction rather than leaving a delayed write', async () => {
  const indexedDB = fakeIdb(), store = createFontLocalStore({ namespace: 'a', indexedDB });
  const pending = store.put('one', new Uint8Array([1]));
  const rejected = assert.rejects(pending, /未保存/);
  for (let i = 0; i < 10 && !indexedDB.operations.length; i++) await Promise.resolve();
  assert.equal(indexedDB.operations.length, 1);
  store.dispose(); await rejected;
  const reopened = createFontLocalStore({ namespace: 'a', indexedDB });
  assert.equal(await reopened.get('one'), null); reopened.dispose();
});
