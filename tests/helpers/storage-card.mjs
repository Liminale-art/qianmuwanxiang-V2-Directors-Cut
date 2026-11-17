import { renderStorageCard } from '../../qianmu-storage-card.js';

const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Renders the data-management card from loose inputs: a partial inventory is
// completed with neutral totals so a test only spells out the part it checks.
export function renderStorageBackupSection(_notes, format = value => `${value} B`, { data, ready = false, scanning = false } = {}) {
  const full = data ? { sampledAt: 1, origin: { available: false }, trackedBytes: 0, categories: [], ...data } : null;
  return renderStorageCard({ state: { status: scanning ? 'loading' : ready ? 'ready' : full ? 'stale' : 'idle', data: full }, format, escape });
}

// Inert stand-ins for everything bindStorageManagementEvents names while wiring
// the card. A test replaces only the collaborators its scenario exercises.
export function storageEventsShell(overrides = {}) {
  const noop = () => {};
  return {
    settings: {}, showQianmuUpdateGuidance: noop, configUndo: { available: () => false }, undoConfigRestore: noop, scheduleStorageScan: noop,
    createStorageLibraryTransfer: () => ({ exports: { focus: noop }, imports: { focus: noop } }),
    resolveImageAccountNamespace: async () => 'st-user:fixture', confirmDialog: async () => true, htmlEscape: escape, ttsDownloadBlob: noop, toast: noop,
    storyboardRequestHeaders: () => ({}), fontLibrary: {}, featureRuntime: { load: async () => ({}) }, storyboardState: () => ({}),
    focusClockLibrary: () => ({ busy: false }), configRestoreActivity: () => ({}), focusLibraryRuntime: noop,
    exportConfig: noop, exportPinnedNotesBackup: noop, exportTtsFavoritesBackup: noop, ttsExportAudioCache: noop, coreadExportData: noop,
    importConfig: noop, importPinnedNotesBackup: noop, importTtsFavoritesBackup: noop, ttsImportAudioCache: noop, coreadImportDataFile: noop,
    proseFloorTools: {}, chatRingtone: { actions: {} }, fileStamp: () => 'stamp', storageDialogs: () => ({}), runStorageExport: noop, runStorageImport: noop,
    ...overrides,
  };
}

// A card root that hands out one stable fake control per selector and records
// the listeners bound to it. click(selector) runs the bound click handler.
export function storageCardRoot() {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) {
      const handlers = new Map();
      nodes.set(selector, { selector, hidden: false, files: [], value: '', handlers, onclick: null,
        addEventListener: (name, callback) => handlers.set(name, callback), click() { return handlers.get('click')?.({ currentTarget: this }); } });
    }
    return nodes.get(selector);
  };
  const backup = { dataset: {}, querySelector: node };
  const outside = new Set(['.sd-storage-service-guide', '.sd-storage-refresh']);
  const root = { isConnected: true, querySelectorAll: () => [], querySelector: selector => selector === '.sd-storage-backup-section' ? backup : outside.has(selector) ? node(selector) : null };
  return { root, backup, node, bound: selector => nodes.get(selector)?.handlers.has('click') === true, click: selector => node(selector).handlers.get('click')({ currentTarget: node(selector) }) };
}
