// Full request/response text of Qianmu's recent API logs, kept out of ST's settings file.
//
// The log list keeps the last few calls with the complete prompt and reply — typically 100 KB or more
// each. They are a debugging aid, read on the device that made the call, yet they were rewritten into
// the shared settings file on every save. In memory nothing changes. In the serialised settings a
// finished log whose text is *confirmed stored* in this browser's IndexedDB (per ST account) is written
// with only the beginning of each text plus a note; on load the full text is put back from IndexedDB.
// On another device, or after browser data was cleared, the shortened text with its note is what remains.
// Logs still running, and logs not yet confirmed stored, are written in full exactly as before.
const HEAD = 1500, MIN_TOTAL = 6000;
const NOTE = '\n\n……（以下省略。完整内容保存在产生这条日志的浏览器里，不随设置同步。）';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const heavy = log => plain(log) && typeof log.id === 'string' && log.id && log.status !== 'loading'
  && typeof log.request === 'string' && typeof log.response === 'string' && log.request.length + log.response.length >= MIN_TOTAL;
const head = text => (text.length > HEAD + NOTE.length ? text.slice(0, HEAD) + NOTE : text);
// Is `full` the text that `short` was cut from?
const matches = (full, short) => (short.endsWith(NOTE) ? full.startsWith(short.slice(0, -NOTE.length)) : full === short);

export function createLogBodiesSidecar({ resolveNamespace, requestSave = () => {}, onRestored = () => {}, indexedDB = globalThis.indexedDB,
  schedule = setTimeout, cancel = clearTimeout, flushDelay = 2500 } = {}) {
  const stored = new Map();      // log id → { request, response } confirmed in IndexedDB
  const queued = new Map();      // log id → { request, response } waiting for the next flush
  const restored = new WeakSet();
  let timer = null, flushing = null, failures = 0, disposed = false, liveIds = new Set();

  async function transaction(mode, work) {
    if (!indexedDB?.open) throw new Error('浏览器不支持本机储存');
    const namespace = String(await resolveNamespace());
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(`qianmu-request-logs::${namespace}`, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('logs')) request.result.createObjectStore('logs', { keyPath: 'id' }); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('日志储存无法打开'));
      request.onblocked = () => reject(new Error('日志储存被其他页面占用'));
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('logs', mode), result = work(tx.objectStore('logs'));
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('日志储存读写失败'));
      });
    } finally { db.close(); }
  }
  const same = (a, log) => !!a && a.request === log.request && a.response === log.response;

  function flush() {
    flushing ||= (async () => {
      const batch = [...queued];
      if (!batch.length || disposed) return false;
      try {
        const keep = new Set(liveIds);
        await transaction('readwrite', store => {
          for (const [id, body] of batch) store.put({ id, request: body.request, response: body.response });
          // Entries that left the log list are removed with the same transaction.
          const cursor = store.openKeyCursor?.();
          if (cursor) cursor.onsuccess = () => { const at = cursor.result; if (!at) return; if (!keep.has(at.key)) store.delete(at.key); at.continue(); };
        });
        if (disposed) return false;
        for (const [id, body] of batch) { stored.set(id, body); if (queued.get(id) === body) queued.delete(id); }
        for (const id of [...stored.keys()]) if (!keep.has(id)) stored.delete(id);
        failures = 0;
        requestSave();
        return true;
      } catch (error) {
        for (const [id, body] of batch) if (queued.get(id) === body) queued.delete(id);
        failures += 1;
        console.warn('[千幕] 请求日志全文暂未移出设置文件（已按完整内容保存）', error?.message || error);
        return false;
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  /** Persistence step: shortens confirmed-stored finished logs in the serialised view. */
  function slimmer(view, settings) {
    const logs = settings?.logHistory;
    if (disposed || !Array.isArray(logs)) return;
    liveIds = new Set(logs.map(log => log?.id).filter(Boolean));
    let changed = false;
    const next = logs.map(log => {
      if (!heavy(log) || log.bodyStored) return log;
      if (!same(stored.get(log.id), log)) {
        if (failures < 3 && !same(queued.get(log.id), log)) {
          queued.set(log.id, { request: log.request, response: log.response });
          if (timer === null) timer = schedule(() => { timer = null; void flush(); }, flushDelay);
        }
        return log;
      }
      changed = true;
      return { ...log, request: head(log.request), response: head(log.response), bodyStored: true };
    });
    if (changed) view.logHistory = next;
  }

  /** Puts full texts back into `settings.logHistory` in place. Logs whose text is not in this browser keep the shortened form. */
  async function restore(settings) {
    if (!plain(settings) || restored.has(settings) || !Array.isArray(settings.logHistory)) return 0;
    restored.add(settings);
    const wanted = settings.logHistory.filter(log => plain(log) && log.bodyStored === true && typeof log.id === 'string');
    if (!wanted.length) return 0;
    let rows = [];
    try {
      const requests = await transaction('readonly', store => wanted.map(log => store.get(log.id)));
      rows = requests.map(request => request.result);
    } catch { return 0; }
    let count = 0;
    wanted.forEach((log, index) => {
      const row = rows[index];
      // The entry may have been replaced while reading; only fill the one that still carries the marker.
      if (!plain(row) || typeof row.request !== 'string' || typeof row.response !== 'string' || log.bodyStored !== true || !settings.logHistory.includes(log)) return;
      if (!matches(row.request, log.request) || !matches(row.response, log.response)) return;
      log.request = row.request; log.response = row.response; delete log.bodyStored;
      stored.set(log.id, { request: row.request, response: row.response });
      count += 1;
    });
    if (count) onRestored();
    return count;
  }

  return Object.freeze({ slimmer, restore, flush, dispose() { disposed = true; cancel(timer); timer = null; queued.clear(); } });
}
