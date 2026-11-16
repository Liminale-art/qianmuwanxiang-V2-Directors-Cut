// 伴读对话（陪读会话：消息、总结、游标）跟随 ST 账户走。
//
// The companion conversations live in this browser's IndexedDB, keyed `scope::bookId`. The bookshelf itself
// (book ids, progress) is in ST settings and already follows the account, so on a second device the books
// were listed but their conversations were missing. This module mirrors each conversation to one ST account
// file and reconciles in the background. IndexedDB stays the working copy; nothing else in the reader changes.
//
// Rules, chosen so that a mistake can cost at most a little network, never a conversation:
//   • Local only → upload. Account only → download. Both → the side that changed since the last sync wins;
//     if both changed, the more recently written one wins and the other is kept in a local "conflicts" store.
//   • Deletions are never propagated. A conversation that was synced and is now gone locally (its book was
//     removed here) is remembered as dismissed on this device and is not downloaded again; the account copy
//     stays for other devices. A wiped browser profile loses that memory too, so everything comes back.
//   • Every remote write is conditional on what was read; a failed or conflicting write is retried on the
//     next round, never forced.
import { sha256 } from './vendor/noble-hashes-2.4.0/sha2.js';
import { createConfiguredStAccountStorage, isStAccountStorageConfigured } from './qianmu-st-account-storage.js';

export const READER_CHAT_INDEX_SLOT = 'reader-chats';
const VERSION = 1, MAX_BYTES = 24 * 1024 * 1024, CONFLICTS_KEPT = 12;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const readerChatSlot = key => `reader-chat-${hex(sha256(new TextEncoder().encode(String(key)))).slice(0, 40)}`;
const canCompress = () => typeof globalThis.CompressionStream === 'function' && typeof globalThis.DecompressionStream === 'function';
const toBase64 = bytes => { let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(binary); };
const fromBase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
const stamp = record => (Number.isFinite(Number(record?.updatedAt)) ? Number(record.updatedAt) : 0);

/** A record can be mirrored only if JSON carries it whole (plain objects, arrays and primitives). Returns the JSON or null. */
function portable(record) {
  if (!plain(record)) return null;
  try {
    // A Blob, Date or Map would serialise to something else without complaint; refuse instead of mirroring a lossy copy.
    const json = JSON.stringify(record, (_key, value) => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('not portable');
      if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('not portable');
      return value;
    });
    return typeof json === 'string' && json.length > 2 ? json : null;
  } catch { return null; }
}
async function pack(json) { return canCompress() ? { gz: toBase64(await pipe(new TextEncoder().encode(json), new CompressionStream('gzip'))) } : { json }; }
async function unpack(body) {
  if (!plain(body)) return null;
  try {
    const json = typeof body.gz === 'string' ? (canCompress() ? new TextDecoder().decode(await pipe(fromBase64(body.gz), new DecompressionStream('gzip'))) : null)
      : typeof body.json === 'string' ? body.json : null;
    const record = json === null ? null : JSON.parse(json);
    return plain(record) ? record : null;
  } catch { return null; }
}

export function createReaderChatSync({
  store, resolveNamespace, isCurrent = () => true, indexedDB = globalThis.indexedDB,
  storageFactory = createConfiguredStAccountStorage, isConfigured = isStAccountStorageConfigured,
  schedule = setTimeout, cancel = clearTimeout, delay = 6000,
} = {}) {
  if (!store || typeof store.listKeys !== 'function' || typeof store.get !== 'function' || typeof store.put !== 'function') throw new TypeError('Reader chat sync needs a local store.');
  let timer = null, running = null, disposed = false, storagePromise = null, again = false, pending = new Set(), pendingAll = false;

  // ── this device's memory of what was synced ──────────────────────────────────────────────────────
  async function memory(mode, work) {
    const namespace = String(await resolveNamespace());
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(`qianmu-reader-chat-sync::${namespace}`, 1);
      request.onupgradeneeded = () => {
        for (const name of ['manifest', 'conflicts']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('伴读同步记录无法打开'));
      request.onblocked = () => reject(new Error('伴读同步记录被其他页面占用'));
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(['manifest', 'conflicts'], mode), result = work(tx.objectStore('manifest'), tx.objectStore('conflicts'));
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('伴读同步记录读写失败'));
      });
    } finally { db.close(); }
  }
  async function readManifest() {
    const request = await memory('readonly', manifest => manifest.getAll());
    return new Map((request.result || []).filter(plain).map(row => [row.id, row]));
  }
  const remember = rows => (rows.length ? memory('readwrite', manifest => { for (const row of rows) manifest.put(row); }) : undefined);
  const keepConflict = (key, side, record) => memory('readwrite', (_manifest, conflicts) => {
    conflicts.put({ id: `${Date.now()}::${side}::${key}`, key, side, record, at: Date.now() });
    const all = conflicts.getAllKeys();
    all.onsuccess = () => { for (const id of (all.result || []).sort().slice(0, -CONFLICTS_KEPT)) conflicts.delete(id); };
  }).catch(() => {});

  // ── account files ────────────────────────────────────────────────────────────────────────────────
  async function storage() {
    if (!isConfigured()) return null;
    storagePromise ||= Promise.resolve().then(() => storageFactory({ maxBytes: MAX_BYTES, documentLayout: 'snapshot', timeoutMs: 60000 }))
      .then(value => (value && typeof value.read === 'function' && typeof value.write === 'function' ? value : null)).catch(() => null);
    const value = await storagePromise;
    if (!value) storagePromise = null;
    return value;
  }
  async function readIndex(target) {
    const result = await target.read(READER_CHAT_INDEX_SLOT);
    const chats = result?.exists && plain(result.value) && result.value.version === VERSION && plain(result.value.chats) ? result.value.chats : {};
    return { chats, fingerprint: result?.exists ? result.fingerprint : null };
  }

  async function reconcile(only = null) {
    const target = await storage();
    if (!target || disposed || !isCurrent()) return { skipped: true };
    const wanted = only ? new Set(only) : null;
    const [index, manifest, keys] = [await readIndex(target), await readManifest(), (await store.listKeys()).map(String)];
    const local = new Map();
    for (const key of keys) if (!wanted || wanted.has(key)) { const record = await store.get(key); if (plain(record)) local.set(key, record); }
    const remote = new Map(Object.values(index.chats).filter(entry => plain(entry) && typeof entry.key === 'string').map(entry => [entry.key, entry]));
    const result = { uploaded: 0, downloaded: 0, dismissed: 0, conflicts: 0, unchanged: 0 };
    const rows = [], indexChanges = new Map();

    const upload = async (key, record) => {
      const json = portable(record);
      if (json === null) return false;
      const slot = readerChatSlot(key), before = await target.read(slot);
      await target.write(slot, { version: VERSION, key, updatedAt: stamp(record), body: await pack(json) }, { expectedFingerprint: before?.exists ? before.fingerprint : null });
      indexChanges.set(slot, { key, updatedAt: stamp(record), bytes: json.length });
      rows.push({ id: key, localAt: stamp(record), remoteAt: stamp(record) });
      result.uploaded += 1;
      return true;
    };
    const download = async (key, entry) => {
      const doc = await target.read(readerChatSlot(key));
      const record = doc?.exists && plain(doc.value) && doc.value.key === key ? await unpack(doc.value.body) : null;
      if (!record) return false;
      await store.put(key, record);
      const written = await store.get(key);
      rows.push({ id: key, localAt: stamp(written), remoteAt: Number(entry.updatedAt) || 0 });
      result.downloaded += 1;
      return true;
    };

    for (const [key, record] of local) {
      if (disposed || !isCurrent()) break;
      const entry = remote.get(key), known = manifest.get(key), localAt = stamp(record), remoteAt = Number(entry?.updatedAt) || 0;
      try {
        if (!entry) { await upload(key, record); continue; }
        const localChanged = !known || known.dismissed || known.localAt !== localAt, remoteChanged = !known || known.dismissed || known.remoteAt !== remoteAt;
        if (!localChanged && !remoteChanged) { result.unchanged += 1; continue; }
        if (localChanged && !remoteChanged) { await upload(key, record); continue; }
        if (!localChanged && remoteChanged) { await download(key, entry); continue; }
        // Both sides changed since the last sync (or this is their first meeting). The newer write wins; the other is kept.
        result.conflicts += 1;
        if (localAt >= remoteAt) {
          const doc = await target.read(readerChatSlot(key)), losing = doc?.exists ? await unpack(doc.value?.body) : null;
          if (losing && portable(losing) !== portable(record)) await keepConflict(key, 'account', losing);
          await upload(key, record);
        } else {
          await keepConflict(key, 'local', record);
          await download(key, entry);
        }
      } catch (error) { console.warn('[千幕] 一段伴读对话本轮未同步，稍后重试', error?.message || error); }
    }
    for (const [key, entry] of remote) {
      if (disposed || !isCurrent()) break;
      if (local.has(key) || (wanted && !wanted.has(key)) || (!wanted && keys.includes(key))) continue;
      const known = manifest.get(key);
      // Synced before and gone now: removed on this device. Remember that; do not bring it back, do not delete it remotely.
      if (known) { if (!known.dismissed) { rows.push({ ...known, dismissed: true }); result.dismissed += 1; } continue; }
      try { await download(key, entry); } catch (error) { console.warn('[千幕] 一段伴读对话本轮未取回，稍后重试', error?.message || error); }
    }
    if (indexChanges.size) {
      // Merge into whatever the index is now; a concurrent writer simply causes a retry next round.
      const latest = await readIndex(target), chats = { ...latest.chats };
      for (const [slot, entry] of indexChanges) chats[slot] = entry;
      await target.write(READER_CHAT_INDEX_SLOT, { version: VERSION, chats }, { expectedFingerprint: latest.fingerprint });
    }
    await remember(rows);
    return result;
  }

  function run(only = null) {
    if (running) { again = again || only === null; return running; }
    running = (async () => {
      try { return await reconcile(only); }
      catch (error) { console.warn('[千幕] 伴读对话同步未完成，稍后重试', error?.message || error); return { failed: true }; }
    })().finally(() => { running = null; if (again && !disposed) { again = false; request(); } });
    return running;
  }
  /**
   * Asks for a background round soon; many requests become one. With a key, only that conversation is
   * looked at (after a save); without, everything is reconciled (start-up).
   */
  function request(key = null, wait = delay) {
    if (disposed) return;
    if (key) pending.add(String(key)); else pendingAll = true;
    if (timer !== null) return;
    timer = schedule(() => {
      timer = null;
      const only = pendingAll ? null : [...pending];
      pending = new Set(); pendingAll = false;
      void run(only);
    }, wait);
  }
  /**
   * Before a conversation is opened: brings in a newer account copy of that one conversation, so that
   * writing here does not overwrite what another device added. Bounded; opening never waits longer.
   */
  function refresh(key, timeoutMs = 2500) {
    if (disposed || !key) return Promise.resolve(false);
    return Promise.race([run([String(key)]).then(() => true, () => false), new Promise(resolve => schedule(() => resolve(false), timeoutMs))]);
  }

  // The two calls the reader makes go through here, so it needs no knowledge of the mirror.
  const get = async key => { await refresh(key); return store.get(key); };
  const put = async (key, record) => { const result = await store.put(key, record); request(key); return result; };

  return Object.freeze({ get, put, request, refresh, run, dispose() { disposed = true; cancel(timer); timer = null; } });
}
