// Mirrors a set of records kept in this browser to ST account files, so they follow the ST account to other
// devices and survive a cleared browser. The browser store stays the working copy; callers keep using it.
//
// One record → one account file (slot `<slotPrefix><sha-256 of the key, 40 hex>`), plus one index file.
// Rules, chosen so that a mistake can cost at most a little network, never a record:
//   • Local only → upload. Account only → download. Both → the side that changed since the last sync wins;
//     if both changed, `order` decides (higher wins, ties keep the local one) and the other version is kept
//     in a local "conflicts" store.
//   • A record that was synced and is now gone locally is remembered as dismissed on this device and is
//     not downloaded again; the account copy stays for other devices. A wiped browser profile loses that
//     memory too, so everything comes back.
//   • A deletion travels only when the caller asks for it with remove(keys) and the store can delete.
//     The account file is then overwritten by a tombstone (no body; the file itself is never removed) and
//     the index entry becomes `{key, deleted:true, at}`. Another device deletes its copy when it meets the
//     tombstone. A copy with changes not yet synced is judged by time: changed after the deletion, it is
//     uploaded again; changed before, it goes too, but is first kept in the local "conflicts" store.
//   • Every remote write is conditional on what was read; a failed or conflicting write is retried on the
//     next round, never forced.
//
// A record type supplies:
//   store      { listKeys(), get(key), put(key, record), delete(key)? }   without delete nothing is ever removed
//   token      record → string|number that changes whenever the record changes
//   order      record → number used to pick a winner when both sides changed, and compared with the time
//              of a deletion (so a mirror that deletes should return the record's last-change time)
//   encode     record → Promise<string|null>   text that carries the record whole; null = leave local
//   decode     text → Promise<record|null>
import { sha256 } from './vendor/noble-hashes-2.4.0/sha2.js';
import { createConfiguredStAccountStorage, isStAccountStorageConfigured } from './qianmu-st-account-storage.js';

const VERSION = 1, MAX_BYTES = 24 * 1024 * 1024, CONFLICTS_KEPT = 12;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const accountMirrorSlot = (prefix, key) => `${prefix}${hex(sha256(new TextEncoder().encode(String(key)))).slice(0, 40)}`;
const canCompress = () => typeof globalThis.CompressionStream === 'function' && typeof globalThis.DecompressionStream === 'function';
export const bytesToBase64 = bytes => { let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(binary); };
export const base64ToBytes = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

/** JSON for a value made only of plain objects, arrays and finite primitives; null for anything JSON would silently alter. */
export function portableJson(value) {
  if (!plain(value)) return null;
  // Walked by hand: JSON.stringify would call toJSON first, so a Date would arrive at a replacer already as a string.
  const seen = new Set();
  const whole = item => {
    // An undefined property is the same as an absent one after a round trip; that is not a loss.
    if (item === null || item === undefined || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
    seen.add(item);
    const ok = (Array.isArray(item) ? item : Object.values(item)).every(whole);
    seen.delete(item);
    return ok;
  };
  try {
    if (!whole(value)) return null;
    const json = JSON.stringify(value);
    return typeof json === 'string' && json.length > 2 ? json : null;
  } catch { return null; }
}
async function pack(text, compress) {
  return compress && canCompress() ? { gz: bytesToBase64(await pipe(new TextEncoder().encode(text), new CompressionStream('gzip'))) } : { json: text };
}
async function unpack(body) {
  if (!plain(body)) return null;
  try {
    if (typeof body.gz === 'string') return canCompress() ? new TextDecoder().decode(await pipe(base64ToBytes(body.gz), new DecompressionStream('gzip'))) : null;
    return typeof body.json === 'string' ? body.json : null;
  } catch { return null; }
}

export function createAccountMirror({
  name, label = name, indexSlot, slotPrefix, store, token, order = () => 0, encode, decode, compress = true,
  resolveNamespace, isCurrent = () => true, onDownloaded = () => {}, onRemoved = () => {}, indexedDB = globalThis.indexedDB,
  storageFactory = createConfiguredStAccountStorage, isConfigured = isStAccountStorageConfigured,
  schedule = setTimeout, cancel = clearTimeout, delay = 6000,
} = {}) {
  if (!store || typeof store.listKeys !== 'function' || typeof store.get !== 'function' || typeof store.put !== 'function') throw new TypeError('Account mirror needs a local store.');
  if (!/^[a-z][a-z0-9-]*$/.test(String(name)) || typeof token !== 'function' || typeof encode !== 'function' || typeof decode !== 'function') throw new TypeError('Account mirror is not fully described.');
  let timer = null, running = null, disposed = false, storagePromise = null, again = false, pending = new Set(), pendingAll = false;
  const slotOf = key => accountMirrorSlot(slotPrefix, key);
  const canDelete = typeof store.delete === 'function';
  // Deletions asked for while a round is already under way; that round must not overwrite their manifest rows.
  const intents = new Set();
  // Entries and rows written by the first version of the reader-chat mirror used `updatedAt` / `localAt` / `remoteAt`.
  const entryToken = entry => entry?.token ?? entry?.updatedAt ?? null;
  const rowTokens = row => ({ local: row.localToken ?? row.localAt ?? null, remote: row.remoteToken ?? row.remoteAt ?? null });

  // ── this device's memory of what was synced ──────────────────────────────────────────────────────
  async function memory(mode, work) {
    const namespace = String(await resolveNamespace());
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(`qianmu-${name}-sync::${namespace}`, 1);
      request.onupgradeneeded = () => {
        for (const storeName of ['manifest', 'conflicts']) if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(`${label}同步记录无法打开`));
      request.onblocked = () => reject(new Error(`${label}同步记录被其他页面占用`));
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(['manifest', 'conflicts'], mode), result = work(tx.objectStore('manifest'), tx.objectStore('conflicts'));
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error(`${label}同步记录读写失败`));
      });
    } finally { db.close(); }
  }
  async function readManifest() {
    const request = await memory('readonly', manifest => manifest.getAll());
    return new Map((request.result || []).filter(plain).map(row => [row.id, row]));
  }
  const remember = rows => (rows.length ? memory('readwrite', manifest => { for (const row of rows) manifest.put(row); }) : undefined);
  const saveConflict = (key, side, text) => memory('readwrite', (_manifest, conflicts) => {
    conflicts.put({ id: `${Date.now()}::${side}::${key}`, key, side, text, at: Date.now() });
    const all = conflicts.getAllKeys();
    all.onsuccess = () => { for (const id of (all.result || []).sort().slice(0, -CONFLICTS_KEPT)) conflicts.delete(id); };
  });
  const keepConflict = (key, side, text) => saveConflict(key, side, text).catch(() => {});

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
    const result = await target.read(indexSlot);
    // The reader-chat mirror's first version called this map `chats`.
    const value = result?.exists && plain(result.value) && result.value.version === VERSION ? result.value : null;
    const entries = plain(value?.entries) ? value.entries : plain(value?.chats) ? value.chats : {};
    return { entries, fingerprint: result?.exists ? result.fingerprint : null };
  }
  const readRemoteText = async (target, key) => {
    const doc = await target.read(slotOf(key));
    return doc?.exists && plain(doc.value) && doc.value.key === key ? unpack(doc.value.body) : null;
  };

  async function reconcile(only = null) {
    const target = await storage();
    if (!target || disposed || !isCurrent()) return { skipped: true };
    const wanted = only ? new Set(only) : null;
    const index = await readIndex(target), manifest = await readManifest(), keys = (await store.listKeys()).map(String);
    const local = new Map();
    for (const key of keys) if (!wanted || wanted.has(key)) { const record = await store.get(key); if (record !== undefined && record !== null) local.set(key, record); }
    const remote = new Map(Object.values(index.entries).filter(entry => plain(entry) && typeof entry.key === 'string').map(entry => [entry.key, entry]));
    const result = { uploaded: 0, downloaded: 0, dismissed: 0, conflicts: 0, unchanged: 0, removed: 0, tombstoned: 0 };
    const rows = [], indexChanges = new Map(), arrived = [], gone = [];
    const asked = new Set([...manifest.values()].filter(row => row.pendingDelete === true).map(row => row.id));
    const forgotten = (key, at) => ({ id: key, deleted: true, at, remoteToken: null });

    const upload = async (key, record, text = null) => {
      text ??= await encode(record);
      if (typeof text !== 'string') return false;
      const slot = slotOf(key), before = await target.read(slot), stamp = token(record);
      await target.write(slot, { version: VERSION, key, token: stamp, body: await pack(text, compress) }, { expectedFingerprint: before?.exists ? before.fingerprint : null });
      indexChanges.set(slot, { key, token: stamp, bytes: text.length });
      rows.push({ id: key, localToken: stamp, remoteToken: stamp });
      result.uploaded += 1;
      return true;
    };
    const download = async (key, entry) => {
      const text = await readRemoteText(target, key), record = typeof text === 'string' ? await decode(text) : null;
      if (record === null || record === undefined || intents.has(key)) return false;
      await store.put(key, record);
      const written = await store.get(key);
      rows.push({ id: key, localToken: token(written), remoteToken: entryToken(entry) });
      arrived.push(key);
      result.downloaded += 1;
      return true;
    };

    for (const [key, record] of local) {
      if (disposed || !isCurrent()) break;
      const entry = remote.get(key), known = manifest.get(key), localToken = token(record), remoteToken = entryToken(entry);
      try {
        // Present although its deletion was asked for: it was made again afterwards, so the request is dropped.
        if (!entry || known?.pendingDelete) { await upload(key, record); continue; }
        const tokens = known && !known.dismissed && !known.deleted ? rowTokens(known) : null;
        if (entry.deleted === true) {
          if (!canDelete) continue;
          const at = Number(entry.at) || 0;
          // Made again after this device handled the same tombstone: it lives.
          if (known?.deleted && known.at === entry.at) { await upload(key, record); continue; }
          if (!tokens || tokens.local !== localToken) {
            // Changed here since the last sync, or never synced: time decides. Later than the deletion, it lives.
            if (Number(order(record)) > at) { await upload(key, record); continue; }
            // Older work goes, but only once a full copy is safely kept here.
            const text = await encode(record);
            if (typeof text !== 'string') continue;
            await saveConflict(key, 'local', text);
            result.conflicts += 1;
          }
          await store.delete(key);
          gone.push(key); rows.push(forgotten(key, entry.at)); result.removed += 1;
          continue;
        }
        const localChanged = !tokens || tokens.local !== localToken, remoteChanged = !tokens || tokens.remote !== remoteToken;
        if (!localChanged && !remoteChanged) { result.unchanged += 1; continue; }
        if (localChanged && !remoteChanged) { await upload(key, record); continue; }
        if (!localChanged && remoteChanged) { await download(key, entry); continue; }
        // Both sides changed since the last sync, or this is their first meeting.
        const localText = await encode(record), remoteText = await readRemoteText(target, key);
        if (typeof localText !== 'string') continue;
        if (localText === remoteText) { rows.push({ id: key, localToken, remoteToken }); result.unchanged += 1; continue; }
        result.conflicts += 1;
        const remoteRecord = typeof remoteText === 'string' ? await decode(remoteText) : null;
        if (remoteRecord === null || remoteRecord === undefined || Number(order(record)) >= Number(order(remoteRecord))) {
          if (typeof remoteText === 'string') await keepConflict(key, 'account', remoteText);
          await upload(key, record, localText);
        } else {
          await keepConflict(key, 'local', localText);
          await download(key, entry);
        }
      } catch (error) { console.warn(`[千幕] 一份${label}本轮未同步，稍后重试`, error?.message || error); }
    }
    for (const key of new Set([...remote.keys(), ...asked])) {
      if (disposed || !isCurrent()) break;
      if (local.has(key) || (wanted && !wanted.has(key)) || (!wanted && keys.includes(key))) continue;
      const entry = remote.get(key), known = manifest.get(key), tomb = entry?.deleted === true;
      try {
        if (known?.pendingDelete && canDelete) {
          if (tomb) { rows.push(forgotten(key, entry.at)); continue; }
          // The file first, then the index (at the end of the round); the request is cleared only when both are written.
          const slot = slotOf(key), before = await target.read(slot);
          await target.write(slot, { version: VERSION, key, deleted: known.at }, { expectedFingerprint: before?.exists ? before.fingerprint : null });
          indexChanges.set(slot, { key, deleted: true, at: known.at });
          rows.push(forgotten(key, known.at)); result.tombstoned += 1;
          continue;
        }
        // Deleted on purpose somewhere: never downloaded, not even by a fresh device.
        if (tomb) { if (!(known?.deleted && known.at === entry.at)) rows.push(forgotten(key, entry.at)); continue; }
        if (!entry) continue;
        // Synced before and gone now without a request: removed on this device only. Remember that; do not bring it back, do not delete it remotely.
        if (known && !known.deleted) { if (!known.dismissed) { rows.push({ ...known, dismissed: true }); result.dismissed += 1; } continue; }
        await download(key, entry);
      } catch (error) { console.warn(`[千幕] 一份${label}本轮未取回，稍后重试`, error?.message || error); }
    }
    if (indexChanges.size) {
      // Merge into whatever the index is now; a concurrent writer simply causes a retry next round.
      const latest = await readIndex(target), entries = { ...latest.entries };
      for (const [slot, entry] of indexChanges) entries[slot] = entry;
      await target.write(indexSlot, { version: VERSION, entries }, { expectedFingerprint: latest.fingerprint });
    }
    // A deletion asked for after this round read the manifest belongs to the next round; its row is left alone.
    await remember(rows.filter(row => !intents.has(row.id) || asked.has(row.id)));
    for (const key of asked) if (rows.some(row => row.id === key)) intents.delete(key);
    if (arrived.length) { try { onDownloaded(arrived); } catch { /* a view refresh must not fail the round */ } }
    if (gone.length) { try { onRemoved(gone); } catch { /* a view refresh must not fail the round */ } }
    return result;
  }

  function run(only = null) {
    if (running) { again = again || only === null; return running; }
    running = (async () => {
      try { return await reconcile(only); }
      catch (error) { console.warn(`[千幕] ${label}同步未完成，稍后重试`, error?.message || error); return { failed: true }; }
    })().finally(() => { running = null; if (again && !disposed) { again = false; request(); } });
    return running;
  }
  /** Asks for a background round soon; many requests become one. With a key only that record is looked at. */
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
  /** Brings in a newer account copy of one record before it is used. Bounded; the caller never waits longer. */
  function refresh(key, timeoutMs = 2500) {
    if (disposed || !key) return Promise.resolve(false);
    return Promise.race([run([String(key)]).then(() => true, () => false), new Promise(resolve => schedule(() => resolve(false), timeoutMs))]);
  }
  /**
   * Carries a deletion the caller has already made locally to the account, so other devices drop the record too.
   * `registered` false: nothing was noted, the account copy stays. `pending`: noted, written on a later round.
   */
  async function remove(keys, { timeoutMs = 8000 } = {}) {
    const ids = [...new Set((Array.isArray(keys) ? keys : [keys]).filter(key => key !== null && key !== undefined && key !== '').map(String))];
    if (!ids.length) return { registered: true, synced: [], pending: [] };
    if (disposed || !canDelete) return { registered: false, synced: [], pending: ids };
    const at = Date.now();
    for (const id of ids) intents.add(id);
    try { await remember(ids.map(id => ({ id, pendingDelete: true, at }))); }
    catch (error) {
      for (const id of ids) intents.delete(id);
      console.warn(`[千幕] ${label}的删除未能登记`, error?.message || error);
      return { registered: false, synced: [], pending: ids };
    }
    // run() hands back a round that is already under way, and that round may not include these keys.
    const settle = (async () => {
      while (running) await running;
      await run(ids);
      const manifest = await readManifest();
      return ids.filter(id => manifest.get(id)?.deleted === true);
    })().catch(error => { console.warn(`[千幕] ${label}的删除本轮未写入账户，稍后重试`, error?.message || error); return []; });
    let handle = null;
    const synced = await Promise.race([settle, new Promise(resolve => { handle = schedule(() => resolve([]), timeoutMs); })]);
    cancel(handle);
    return { registered: true, synced, pending: ids.filter(id => !synced.includes(id)) };
  }
  return Object.freeze({ request, refresh, run, remove, slotOf, dispose() { disposed = true; cancel(timer); timer = null; } });
}
