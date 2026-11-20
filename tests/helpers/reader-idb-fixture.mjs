// A small in-memory IndexedDB for the browser store module (out-of-line keys only), so node tests can drive the
// real qianmu-blobstore.js transactions: get / getKey / put / add / delete / getAll / getAllKeys / count / clear,
// key and value cursors with an optional bound range, and transactions that complete or abort as a whole.
export function installMemoryIndexedDB(target = globalThis) {
  const databases = new Map();
  const sorted = map => [...map.keys()].sort((a, b) => (typeof a === typeof b ? (a < b ? -1 : a > b ? 1 : 0) : typeof a === 'number' ? -1 : 1));
  const inRange = (key, range) => !range || (key >= range.lower && key <= range.upper);
  function transaction(db, names) {
    const tx = { error: null }, list = [].concat(names), working = new Map();
    let pending = 0, finished = false;
    const copyOf = name => { if (!working.has(name)) working.set(name, new Map(db.stores.get(name))); return working.get(name); };
    const settle = () => {
      if (finished || pending) return;
      finished = true;
      for (const [name, rows] of working) db.stores.set(name, rows);
      tx.oncomplete?.({ target: tx });
    };
    const request = work => {
      const req = {}; pending++;
      setTimeout(() => {
        if (finished) return;
        try { req.result = work(); } catch (error) { req.error = error; pending--; req.onerror?.({ target: req }); tx.abort(); return; }
        try { req.onsuccess?.({ target: req }); } finally { pending--; setTimeout(settle, 0); }
      }, 0);
      return req;
    };
    tx.abort = () => { if (finished) return; finished = true; tx.error ||= new Error('aborted'); setTimeout(() => tx.onabort?.({ target: tx }), 0); };
    tx.objectStore = name => {
      if (!list.includes(name) || !db.stores.has(name)) throw new Error(`store ${name} is not in this transaction`);
      const rows = () => copyOf(name);
      const cursor = (range, withValue) => {
        let keys = null, at = 0, req;
        const step = () => {
          keys ??= sorted(rows()).filter(key => inRange(key, range));
          while (at < keys.length && !rows().has(keys[at])) at++;
          if (at >= keys.length) return null;
          const key = keys[at];
          return { key, ...(withValue ? { value: rows().get(key) } : {}), continue() { at++; pending++; setTimeout(() => {
            if (finished) return;
            try { req.result = step(); req.onsuccess?.({ target: req }); } catch (error) { tx.error = error; tx.abort(); return; } finally { pending--; }
            setTimeout(settle, 0);
          }, 0); } };
        };
        req = request(step);
        return req;
      };
      return {
        get: key => request(() => rows().get(key)),
        getKey: key => request(() => (rows().has(key) ? key : undefined)),
        put: (value, key) => request(() => { rows().set(key, value); return key; }),
        add: (value, key) => request(() => { const id = key ?? (Math.max(0, ...[...rows().keys()].filter(Number.isFinite)) + 1); rows().set(id, value); return id; }),
        delete: key => request(() => { rows().delete(key); }),
        clear: () => request(() => { rows().clear(); }),
        count: () => request(() => rows().size),
        getAll: () => request(() => sorted(rows()).map(key => rows().get(key))),
        getAllKeys: () => request(() => sorted(rows())),
        openCursor: range => cursor(range, true),
        openKeyCursor: range => cursor(range, false),
      };
    };
    setTimeout(settle, 0);
    return tx;
  }
  const previous = { indexedDB: target.indexedDB, IDBKeyRange: target.IDBKeyRange };
  target.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
  target.indexedDB = { open(name) {
    const req = {};
    setTimeout(() => {
      let db = databases.get(name);
      const fresh = !db;
      if (fresh) { db = { stores: new Map() }; databases.set(name, db); }
      const handle = { objectStoreNames: { contains: store => db.stores.has(store) }, createObjectStore: store => { db.stores.set(store, new Map()); },
        transaction: names => transaction(db, names), close() {} };
      req.result = handle;
      if (fresh) req.onupgradeneeded?.({ target: req });
      req.onsuccess?.({ target: req });
    }, 0);
    return req;
  } };
  return { databases, restore() { target.indexedDB = previous.indexedDB; target.IDBKeyRange = previous.IDBKeyRange; } };
}
