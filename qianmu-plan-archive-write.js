// Immutable plan archive variants. Hashing finishes before the IndexedDB transaction.
// Native Web Crypto avoids importing media parsers into the shared blob store.
const identity = row => JSON.stringify([row.chatKey, row.planId, row.plan]);
export async function writePreservedPlanArchives(db, storeName, records) {
  const copies = records.map(row => structuredClone(row));
  const prepared = await Promise.all(copies.map(async record => {
    const content = identity(record);
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    const hash = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2,'0')).join('');
    return {record, content, variant:`${record.key}\u241frevision:${hash}`};
  }));
  if (!prepared.length) return {stored:[]};
  const tx = db.transaction(storeName,'readwrite'), target = tx.objectStore(storeName), stored = [];
  return new Promise((resolve,reject) => {
    let failure;
    const abort = error => { failure = error; try { tx.abort(); } catch (_) { reject(error); } };
    tx.oncomplete = () => resolve({stored});
    tx.onerror = () => reject(failure || tx.error || new Error('归档写入失败，旧记录未覆盖'));
    tx.onabort = () => reject(failure || tx.error || new Error('归档写入已撤销'));
    const next = index => {
      if (index >= prepared.length) return;
      const {record,content,variant} = prepared[index];
      const select = key => {
        const request = target.get(key);
        request.onsuccess = () => {
          try {
            if (request.result !== undefined) {
              // Check actual payload even for matching digests; never overwrite a collision.
              if (identity(request.result) === content) { stored.push(key); next(index+1); }
              else if (key === record.key) select(variant);
              else abort(new Error('归档内容校验冲突，旧记录已保留'));
            } else {
              const write = target.add({...record,key},key);
              write.onsuccess = () => { stored.push(key); next(index+1); };
            }
          } catch (error) { abort(error); }
        };
      };
      try { select(record.key); } catch (error) { abort(error); }
    };
    next(0);
  });
}
