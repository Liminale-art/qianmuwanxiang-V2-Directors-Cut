import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../qianmu-blobstore.js';

// 升级库版本时：别的标签页挡住要通知宿主（请求继续等）；本页拿到连接后，别人要升级时主动让出。
test('blocked upgrade notifies the host and an opened connection yields to a later upgrade', async () => {
  const saved = globalThis.indexedDB;
  const requests = [];
  globalThis.indexedDB = { open(name, version) { const req = { name, version }; requests.push(req); return req; } };
  let blocked = 0;
  store.configureBlobStoreAccount({ onBlocked: () => { blocked += 1; } });
  try {
    const pending = store.getAudio('k');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    requests[0].onblocked();
    assert.equal(blocked, 1);
    let closed = 0;
    const db = {
      close() { closed += 1; },
      transaction() {
        const tx = { objectStore: () => ({ get: () => { const r = {}; setImmediate(() => { r.result = undefined; r.onsuccess?.(); }); return r; } }) };
        return tx;
      },
    };
    requests[0].result = db;
    requests[0].onsuccess();
    await pending.catch(() => {});
    db.onversionchange();
    assert.equal(closed, 1);
    // 让出后再用会重新打开，而不是用已关掉的连接。
    void store.getAudio('k').catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 2);
  } finally {
    globalThis.indexedDB = saved;
    store.configureBlobStoreAccount();
  }
});
