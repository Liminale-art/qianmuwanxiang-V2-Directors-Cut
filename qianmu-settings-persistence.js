// What Qianmu writes into ST's settings file, as opposed to what it keeps in memory.
//
// ST serialises every extension's settings into one file and rewrites the whole file on each save, so
// anything bulky or duplicated in Qianmu's settings is uploaded again on every toggle anywhere in ST.
// The settings object in memory stays exactly as the rest of the code expects it; this module only
// decides the shape that JSON.stringify sees, through a non-enumerable `toJSON` on the settings object,
// and puts back on load whatever that shape left out.
//
// Rules for anything added here:
//   • the persisted shape must be restorable to the in-memory shape without loss, by `restore` below;
//   • when in doubt, write the full value — a larger file is always preferable to a missing one;
//   • a failure while slimming falls back to the full object.
// Copies made with spread or structuredClone do not carry the hook, so exports and backups stay complete.
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const NONE = Object.freeze([]);

/** 幕外：`lastOutput` is the same scene as the first of `recentOutputs`; write it once. */
function slimTheater(theater) {
  if (!plain(theater) || !plain(theater.lastOutput) || !Array.isArray(theater.recentOutputs)) return theater;
  const first = theater.recentOutputs[0];
  if (!plain(first) || !first.id || first.id !== theater.lastOutput.id) return theater;
  // Only when the two really are the same scene; an edited copy that drifted apart is written in full.
  if (first !== theater.lastOutput && JSON.stringify(first) !== JSON.stringify(theater.lastOutput)) return theater;
  return { ...theater, lastOutput: null };
}
function restoreTheater(theater) {
  if (!plain(theater) || theater.lastOutput || !Array.isArray(theater.recentOutputs)) return;
  if (plain(theater.recentOutputs[0])) theater.lastOutput = theater.recentOutputs[0];
}

/** The two per-chat preset tables only ever seeded a one-time migration to the global tables. */
function dropMigratedPresetTables(settings) {
  if (settings._presetGlobalMigrated !== true) return;
  for (const name of ['selectedPresetNamesByChat', 'selectedPresetItemsByChat']) {
    if (plain(settings[name]) && Object.keys(settings[name]).length) settings[name] = {};
  }
}

export function persistedSettingsView(settings, { slimmers = NONE } = {}) {
  const view = { ...settings };
  if ('theater' in view) view.theater = slimTheater(view.theater);
  for (const slim of slimmers) slim(view, settings);
  return view;
}

/**
 * Restores what the persisted shape left out, then installs the hook. Idempotent; returns the same object.
 * `slimmers` are further `(view, settings) => void` steps supplied by features that keep a side store;
 * `restorers` are their `settings => Promise` counterparts.
 */
const restoring = new WeakSet();
export function attachSettingsPersistence(settings, { slimmers = NONE, restorers = NONE } = {}) {
  if (!plain(settings)) return settings;
  restoreTheater(settings.theater);
  dropMigratedPresetTables(settings);
  // Asynchronous restorers (side stores) run once per settings object and only fill memory back in.
  if (restorers.length && !restoring.has(settings)) {
    restoring.add(settings);
    for (const restore of restorers) Promise.resolve().then(() => restore(settings)).catch(error => console.warn('[千幕] 设置旁路内容未取回', error?.message || error));
  }
  const current = Object.getOwnPropertyDescriptor(settings, 'toJSON');
  if (current?.value?.qianmuPersistence && current.value.slimmers === slimmers) return settings;
  const toJSON = function () {
    try { return persistedSettingsView(this, { slimmers }); }
    catch (error) { console.warn('[千幕] 设置精简未完成，本次按完整内容保存', error); return { ...this }; }
  };
  toJSON.qianmuPersistence = true; toJSON.slimmers = slimmers;
  Object.defineProperty(settings, 'toJSON', { value: toJSON, enumerable: false, configurable: true, writable: true });
  return settings;
}
