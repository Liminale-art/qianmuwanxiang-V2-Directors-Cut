// Immutable plan archive variants. Hashing finishes before the IndexedDB transaction.
// Native Web Crypto avoids importing media parsers into the shared blob store.
const identity = row => JSON.stringify([row.chatKey, row.planId, row.plan]);
export async function preserveCapturedPlanArchives(captures, write) {
  const result = await write(captures.map(item => ({key:item.key, chatKey:item.chatKey, planId:item.id,
    plan:structuredClone(item.plan), updatedAt:item.updatedAt})), {preserveExisting:true});
  const keys = result?.stored;
  if (!Array.isArray(keys) || keys.length !== captures.length || keys.some((key,index) => {
    const base = captures[index].key, prefix = `${base}\u241frevision:`;
    return typeof key !== 'string' || !key || (key !== base && (!key.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(key.slice(prefix.length))));
  })) throw new Error('归档返回位置不完整，已保留完整镜头内容');
  return captures.map((item,index) => ({...item,key:keys[index]}));
}

export async function writePreservedPlanArchives(db, storeName, records) {
  const copies = records.map(row => structuredClone(row));
  const prepared = await Promise.all(copies.map(async record => {
    const content = identity(record);
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    const hash = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2,'0')).join('');
    return {record, key:record.key, content, variant:`${record.key}\u241frevision:${hash}`};
  }));
  return writePreservedRecords(db, storeName, prepared, identity);
}

// Detailed logs have no variant reference in their consumers. On a collision,
// reject the whole batch so callers keep the complete inline log instead.
export function writePreservedPipelineLogs(db, storeName, records) {
  const contentOf = row => { const { archivedAt, ...content } = row; return JSON.stringify(content); };
  const prepared = records.map(row => {
    const record = structuredClone(row);
    return { record, key:record.id, content:contentOf(record) };
  });
  return writePreservedRecords(db, storeName, prepared, contentOf);
}

export function writePreservedSnapshotArchives(db, storeName, records) {
  const contentOf = row => JSON.stringify([row.chatKey, row.recordId, row.snapshot]);
  const prepared = records.map(row => {
    const record = structuredClone(row);
    return {record, key:record.key, content:contentOf(record)};
  });
  return writePreservedRecords(db, storeName, prepared, contentOf);
}

function writePreservedRecords(db, storeName, prepared, contentOf) {
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
      const {record,key:base,content,variant} = prepared[index];
      const select = key => {
        const request = target.get(key);
        request.onsuccess = () => {
          try {
            if (request.result !== undefined) {
              // Check actual payload even for matching digests; never overwrite a collision.
              if (contentOf(request.result) === content) { stored.push(key); next(index+1); }
              else if (variant && key === base) select(variant);
              else abort(new Error('归档内容校验冲突，旧记录已保留'));
            } else {
              const write = target.add(variant ? {...record,key} : record,key);
              write.onsuccess = () => { stored.push(key); next(index+1); };
            }
          } catch (error) { abort(error); }
        };
      };
      try { select(base); } catch (error) { abort(error); }
    };
    next(0);
  });
}
