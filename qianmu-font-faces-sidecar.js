// Where the heavy part of the font catalogue lives, so that it is not rewritten with every ST settings save.
//
// A web font is a list of "faces": for a CJK family that is often a hundred or more slices, each with its
// file URL and a long unicode-range. A handful of such fonts is megabytes of text, and it sat inside ST's
// settings file, which ST uploads in full whenever any setting anywhere changes.
//
// The font library itself is untouched: in memory every font carries its faces exactly as before. Only the
// serialised settings differ (see qianmu-settings-persistence.js): a web font whose faces are *confirmed
// stored* is written as `{ ...font, faces: [], facesRef: <sha-256 of the faces JSON> }`.
//
// "Confirmed stored" means both copies exist:
//   • this browser's IndexedDB (per ST account) — read at start-up, no network;
//   • one ST account file (slot `font-faces`) — survives a cleared browser and follows the account to
//     other devices.
// Until both writes have succeeded a font is written in full, as before. On load, fonts are filled back
// in before the font library is allowed to read them; if a referenced face list cannot be obtained yet
// (account file unreachable on a fresh device) nothing is modified and nothing is dropped — the library
// simply starts later, when a retry succeeds.
import { sha256 } from './vendor/noble-hashes-2.4.0/sha2.js';
import { createConfiguredStAccountStorage, isStAccountStorageConfigured } from './qianmu-st-account-storage.js';

export const FONT_FACES_SLOT = 'font-faces';
const VERSION = 1, MIN_JSON = 2048, MAX_BYTES = 16 * 1024 * 1024, KEEP_UNREFERENCED_MS = 30 * 24 * 60 * 60 * 1000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const fontFacesRef = json => hex(sha256(new TextEncoder().encode(json)));
const isRef = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const slimmed = font => plain(font) && isRef(font.facesRef) && Array.isArray(font.faces) && font.faces.length === 0;

export function createFontFacesSidecar({
  resolveNamespace, requestSave = () => {}, notify = () => {}, indexedDB = globalThis.indexedDB,
  storageFactory = createConfiguredStAccountStorage, isConfigured = isStAccountStorageConfigured,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout, flushDelay = 1500, retryDelays = [4000, 15000, 60000, 300000],
} = {}) {
  const stored = new Map();        // faces JSON → ref: both copies confirmed, safe to write slim
  const queued = new Map();        // faces JSON → ref: waiting for the next flush
  let flushTimer = null, flushing = null, failures = 0, disposed = false, storagePromise = null;
  const readies = new WeakMap();

  // ── local cache ──────────────────────────────────────────────────────────────────────────────────
  async function database() {
    if (!indexedDB?.open) return null;
    const namespace = String(await resolveNamespace());
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(`qianmu-font-faces::${namespace}`, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('faces')) request.result.createObjectStore('faces', { keyPath: 'ref' }); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('字体分片缓存无法打开'));
      request.onblocked = () => reject(new Error('字体分片缓存被其他页面占用'));
    });
  }
  async function cache(mode, work) {
    const db = await database();
    if (!db) return undefined;
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('faces', mode), store = transaction.objectStore('faces');
        let value;
        const request = work(store);
        if (request) request.onsuccess = () => { value = request.result; };
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('字体分片缓存读写失败'));
      });
    } finally { db.close(); }
  }
  const cacheGet = async ref => { try { return (await cache('readonly', store => store.get(ref)))?.json ?? null; } catch { return null; } };
  const cachePut = (ref, json) => cache('readwrite', store => { store.put({ ref, json, at: now() }); });

  // ── durable account copy ─────────────────────────────────────────────────────────────────────────
  async function storage() {
    if (!isConfigured()) return null;
    storagePromise ||= Promise.resolve().then(() => storageFactory({ maxBytes: MAX_BYTES, documentLayout: 'snapshot' }))
      .then(value => (value && typeof value.read === 'function' && typeof value.write === 'function' ? value : null))
      .catch(() => null);
    const value = await storagePromise;
    if (!value) storagePromise = null;
    return value;
  }
  async function readDocument(target) {
    const result = await target.read(FONT_FACES_SLOT);
    const value = result?.exists && plain(result.value) && result.value.version === VERSION && plain(result.value.faces) ? result.value.faces : {};
    return { faces: value, fingerprint: result?.exists ? result.fingerprint : null };
  }

  // ── writing ──────────────────────────────────────────────────────────────────────────────────────
  function queue(json) {
    if (disposed || queued.has(json) || failures >= 3) return;
    queued.set(json, null);   // hashed in flush(), never on the settings-save path
    if (flushTimer === null) flushTimer = schedule(() => { flushTimer = null; void flush(); }, flushDelay);
  }
  function flush() {
    flushing ||= (async () => {
      const batch = [...queued.keys()].map(json => [json, fontFacesRef(json)]);
      if (!batch.length || disposed) return false;
      try {
        const target = await storage();
        if (!target) throw new Error('账户文件储存未就绪');
        for (const [json, ref] of batch) await cachePut(ref, json);
        const document = await readDocument(target), faces = { ...document.faces }, moment = now();
        const live = new Set([...stored.values(), ...batch.map(([, ref]) => ref)]);
        for (const [json, ref] of batch) faces[ref] = { faces: JSON.parse(json), seen: moment };
        // Unreferenced lists are kept for a while: a settings file restored from an older backup may
        // still point at them.
        for (const [ref, entry] of Object.entries(faces)) {
          if (live.has(ref)) { if (plain(entry)) entry.seen = moment; }
          else if (!plain(entry) || !(Number(entry.seen) > moment - KEEP_UNREFERENCED_MS)) delete faces[ref];
        }
        await target.write(FONT_FACES_SLOT, { version: VERSION, faces }, { expectedFingerprint: document.fingerprint });
        if (disposed) return false;
        for (const [json, ref] of batch) { stored.set(json, ref); queued.delete(json); }
        failures = 0;
        requestSave();   // the next save can now write these fonts slim
        return true;
      } catch (error) {
        for (const [json] of batch) queued.delete(json);   // written in full meanwhile; a later save queues them again
        failures += 1;
        console.warn('[千幕] 字体分片暂未移出设置文件（已按完整内容保存，不影响使用）', error?.message || error);
        return false;
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  /** Persistence step: replaces confirmed-stored web-font faces with a reference in the serialised view. */
  function slimmer(view, settings) {
    const library = settings?.fontLibrary;
    if (disposed || !plain(library) || !Array.isArray(library.fonts)) return;
    let changed = false;
    const fonts = library.fonts.map(font => {
      if (!plain(font) || font.source?.kind !== 'web' || !Array.isArray(font.faces) || !font.faces.length) return font;
      const json = JSON.stringify(font.faces);
      if (json.length < MIN_JSON) return font;
      const ref = stored.get(json);
      if (!ref) { queue(json); return font; }
      changed = true;
      return { ...font, faces: [], facesRef: ref };
    });
    if (changed) view.fontLibrary = { ...library, fonts };
  }

  // ── reading ──────────────────────────────────────────────────────────────────────────────────────
  /** Fills referenced faces back into `settings.fontLibrary` in place. All or nothing; true when complete. */
  async function hydrate(settings) {
    const fonts = Array.isArray(settings?.fontLibrary?.fonts) ? settings.fontLibrary.fonts.filter(slimmed) : [];
    if (!fonts.length) return true;
    const found = new Map(); let remote = null;
    for (const ref of new Set(fonts.map(font => font.facesRef))) {
      let json = await cacheGet(ref), fromCache = json !== null;
      if (json === null || fontFacesRef(json) !== ref) {
        fromCache = false; json = null;
        if (remote === null) { const target = await storage(); remote = target ? (await readDocument(target)).faces : {}; }
        const entry = remote[ref];
        if (plain(entry) && Array.isArray(entry.faces) && entry.faces.length) json = JSON.stringify(entry.faces);
      }
      if (json === null || fontFacesRef(json) !== ref) return false;
      found.set(ref, json);
      if (!fromCache) await cachePut(ref, json).catch(() => {});
    }
    if (disposed) return false;
    // Re-check: the object may have been replaced or already filled while reading.
    for (const font of fonts) {
      if (!slimmed(font)) continue;
      const json = found.get(font.facesRef);
      font.faces = JSON.parse(json); delete font.facesRef;
      stored.set(json, fontFacesRef(json));
    }
    return true;
  }
  /** Resolves once the settings' fonts are complete; keeps retrying quietly when a face list is not reachable yet. */
  function ready(settings) {
    if (!plain(settings)) return Promise.resolve(true);
    let promise = readies.get(settings);
    if (!promise) {
      promise = (async () => {
        for (let attempt = 0; !disposed; attempt++) {
          let complete = false;
          try { complete = await hydrate(settings); } catch (error) { console.warn('[千幕] 字体分片读取失败，稍后重试', error?.message || error); }
          if (complete) return true;
          if (attempt === 0) notify('部分网络字体的资料暂未取回，稍后自动重试；期间使用原生字体。');
          await new Promise(resolve => schedule(resolve, retryDelays[Math.min(attempt, retryDelays.length - 1)]));
        }
        return false;
      })();
      readies.set(settings, promise);
    }
    return promise;
  }

  /**
   * Wraps the font library so that nothing reads the catalogue before its faces are back in place.
   * Everything else passes straight through.
   */
  function gate(library, currentSettings) {
    const wait = () => ready(currentSettings());
    let attachment = 0;
    return Object.freeze(Object.assign(Object.create(library), {
      activate() { void wait().then(complete => { if (complete) library.activate(); }); },
      sync: () => wait().then(complete => (complete ? library.sync() : undefined)),
      attach(root) { const token = ++attachment; void wait().then(complete => { if (complete && token === attachment && root?.isConnected !== false) library.attach(root); }); },
      detach(...args) { attachment++; return library.detach(...args); },
    }));
  }

  return Object.freeze({ slimmers: Object.freeze([slimmer]), slimmer, hydrate, ready, flush, gate,
    dispose() { disposed = true; cancel(flushTimer); flushTimer = null; queued.clear(); } });
}
