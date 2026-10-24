import { createConfiguredStAccountStorage, isStAccountStorageConfigured } from './qianmu-st-account-storage.js';
import { normalizeFontLibrary, mergeFontLibraryRecords } from './qianmu-font-library-state.js?v=1.59.482-font-progress-2';

// The account document is deliberately a small metadata-only directory. Local
// font bytes stay in the browser's IndexedDB. ST exposes account files, not a
// native font-binary library; pushing large Base64 originals through that
// generic file endpoint made ordinary add/apply/delete actions wait on a
// multi-request confirmation path and could hit the transport timeout. A
// catalog-only document keeps the cross-device list and assignments useful
// without pretending that a missing local original can be restored silently.
export const FONT_ACCOUNT_SYNC_SLOT = 'font-library';
export const FONT_ACCOUNT_SYNC_VERSION = 1;
const CATALOG_MAX_BYTES = 8 * 1024 * 1024;
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const uniqueId = () => `f_${globalThis.crypto?.randomUUID?.().replaceAll('-', '') || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;

function stateWithoutPreference(value) {
  const state = normalizeFontLibrary(value);
  const { syncLocalOriginals: _ignored, ...catalog } = state;
  return catalog;
}

function catalogValue(value) {
  if (!plain(value) || value.version !== FONT_ACCOUNT_SYNC_VERSION || !plain(value.library)) {
    throw new Error('字体账户目录格式无效，未覆盖本机字体');
  }
  // Older catalogs may still contain an `originals` map. It is intentionally
  // ignored rather than read or migrated: immutable binary bodies cannot be
  // removed through the native ST files endpoint, and using them again would
  // reintroduce the slow/uncertain path this catalog no longer promises.
  return { library: normalizeFontLibrary(value.library) };
}

export function createFontAccountSync({ storageFactory = createConfiguredStAccountStorage } = {}) {
  let storage = null;
  let storagePromise = null;
  let disabled = false;
  let fingerprint = null;

  async function ensureStorage() {
    if (disabled) return null;
    if (storage) return storage;
    if (storagePromise) return storagePromise;
    if (!isStAccountStorageConfigured() && storageFactory === createConfiguredStAccountStorage) return null;
    storagePromise = Promise.resolve().then(() => storageFactory({ maxBytes: CATALOG_MAX_BYTES, documentLayout: 'snapshot' }))
      .then(value => {
        // createConfiguredStAccountStorage builds the transport asynchronously.
        // Treat both synchronous test adapters and the real Promise-returning
        // factory uniformly, and fail closed before any method is dereferenced.
        if (!value || typeof value.read !== 'function' || typeof value.write !== 'function') {
          throw new Error('字体账户储存接口无效');
        }
        storage = value;
        return storage;
      })
      .catch(() => {
        disabled = true;
        return null;
      })
      .finally(() => { storagePromise = null; });
    return storagePromise;
  }

  async function readCatalog() {
    const current = await ensureStorage();
    if (!current) return { value: null, fingerprint: null };
    const result = await current.read(FONT_ACCOUNT_SYNC_SLOT);
    if (!result?.exists) { fingerprint = null; return { value: null, fingerprint: null }; }
    const value = catalogValue(result.value);
    fingerprint = result.fingerprint;
    return { value, fingerprint };
  }

  async function writeCatalog(value, expectedFingerprint) {
    const current = await ensureStorage();
    if (!current) return null;
    const result = await current.write(FONT_ACCOUNT_SYNC_SLOT, value, { expectedFingerprint });
    fingerprint = result?.fingerprint ?? fingerprint;
    return result;
  }

  async function push(state, { localStore } = {}) {
    // Keep the old optional argument for callers and tests. The account path
    // deliberately never reads localStore now: originals remain local-only.
    const current = await ensureStorage();
    if (!current) return { state: normalizeFontLibrary(state), synced: false };
    const previous = await readCatalog();
    const library = normalizeFontLibrary(state);
    const value = { version: FONT_ACCOUNT_SYNC_VERSION, library: stateWithoutPreference(library) };
    if (previous.value && JSON.stringify(previous.value.library) === JSON.stringify(value.library)) {
      return { state: library, synced: true, changed: false };
    }
    await writeCatalog(value, previous.fingerprint);
    return { state: library, synced: true, changed: true };
  }

  async function hydrate(localState, { localStore } = {}) {
    const local = normalizeFontLibrary(localState);
    const current = await ensureStorage();
    if (!current) return { state: local, changed: false, synced: false };
    const remote = await readCatalog();
    if (!remote.value) {
      const result = await push(local, { localStore });
      return { state: local, changed: false, synced: result.synced };
    }
    const merged = mergeFontLibraryRecords(remote.value.library, local.fonts, uniqueId).state;
    const state = normalizeFontLibrary({ ...merged, syncLocalOriginals: true });
    const changed = JSON.stringify(stateWithoutPreference(state)) !== JSON.stringify(remote.value.library);
    if (changed) await writeCatalog({ version: FONT_ACCOUNT_SYNC_VERSION, library: stateWithoutPreference(state) }, remote.fingerprint);
    fingerprint = fingerprint || remote.fingerprint;
    return { state, changed, synced: true };
  }

  return Object.freeze({ hydrate, push, close() { storage?.close?.(); storage = null; storagePromise = null; } });
}

