// Local font bytes stay in this browser/account. The background account-sync
// layer mirrors only the directory metadata; explicit font-package export is
// the path for moving these bytes. This store never reads or writes chat/files
// endpoints.
const STORE = 'fonts';

function fontKey(id) {
  const value = String(id || '').trim();
  if (!value || value.length > 200) throw new Error('字体标识无效');
  return value;
}

export function createFontLocalStore({ namespace, indexedDB = globalThis.indexedDB, Blob: BlobClass = globalThis.Blob } = {}) {
  const account = String(namespace || '').trim();
  if (!account || account.length > 256) throw new Error('尚未确认当前账户，不能存取本地字体');
  let opening = null, database = null, disposed = false;
  const transactions = new Set();

  function open() {
    if (disposed) return Promise.reject(new Error('字体库已关闭'));
    if (!indexedDB?.open) return Promise.reject(new Error('此浏览器不支持保存本地字体，请使用 Web 引用'));
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(`qianmu-fonts:${encodeURIComponent(account)}`, 1);
      let settled = false;
      const fail = (error) => { if (!settled) { settled = true; reject(error); } };
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onerror = () => fail(new Error('本地字体库无法打开，请检查浏览器存储权限'));
      request.onblocked = () => fail(new Error('本地字体库正被其他页面占用，请关闭旧页面后重试'));
      request.onsuccess = () => {
        const result = request.result;
        if (disposed || settled) { result.close(); fail(new Error('字体库已关闭')); return; }
        settled = true; database = result;
        result.onversionchange = () => { result.close(); if (database === result) database = null; };
        resolve(result);
      };
    }).finally(() => { opening = null; });
    return opening;
  }

  async function transaction(mode, action) {
    const db = await open();
    if (disposed) throw new Error('字体库已关闭');
    return new Promise((resolve, reject) => {
      let result, finished = false;
      const tx = db.transaction(STORE, mode);
      transactions.add(tx);
      const fail = () => { transactions.delete(tx); if (!finished) { finished = true; reject(new Error(mode === 'readonly' ? '本地字体读取失败' : '本地字体未保存，请检查浏览器存储空间')); } };
      tx.onabort = fail; tx.onerror = fail;
      tx.oncomplete = () => { transactions.delete(tx); if (!finished) { finished = true; resolve(result); } };
      try { action(tx.objectStore(STORE), (value) => { result = value; }); }
      catch (error) { finished = true; transactions.delete(tx); try { tx.abort(); } catch (_) {} reject(error); }
    });
  }

  return {
    async put(id, bytes, mime = 'application/octet-stream') {
      const key = fontKey(id);
      if (!BlobClass) throw new Error('此浏览器不支持保存本地字体');
      if (!(bytes instanceof BlobClass) && !(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) throw new Error('字体文件无效');
      const blob = bytes instanceof BlobClass ? bytes : new BlobClass([bytes], { type: mime });
      if (!blob.size) throw new Error('字体文件为空');
      await transaction('readwrite', (store) => { store.put(blob, key); });
      return key;
    },
    async get(id) {
      return transaction('readonly', (store, done) => {
        const request = store.get(fontKey(id));
        request.onsuccess = () => done(request.result instanceof BlobClass ? request.result : null);
      });
    },
    async delete(ids) {
      const keys = [...new Set((Array.isArray(ids) ? ids : [ids]).map(fontKey))];
      await transaction('readwrite', (store) => { for (const key of keys) store.delete(key); });
    },
    dispose() {
      disposed = true;
      for (const tx of transactions) { try { tx.abort(); } catch (_) {} }
      transactions.clear(); database?.close(); database = null;
    },
  };
}
