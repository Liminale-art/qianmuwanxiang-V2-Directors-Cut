import {configRestoreGuard} from './qianmu-config-connections.js';

// A single in-memory recovery record, never a log/settings field or media backup.
// The caller must capture `previous` before applying and arm against an unchanged owner.
export function createConfigUndoSlot({clone = structuredClone} = {}) {
  let record = null;
  const clear = () => { record = null; };
  return {
    clear,
    remember(previous, current) {
      clear();
      try {
        if (!previous?.settings || typeof previous.settings !== 'object' || Array.isArray(previous.settings)
          || !current || typeof current !== 'object' || Array.isArray(current) || previous.settings === current) return false;
        const snapshot = clone(previous), unchanged = configRestoreGuard(current);
        if (!unchanged(current)) return false;
        record = {snapshot, unchanged};
        return true;
      } catch (_) { return false; }
    },
    available(current) { return !!record && record.unchanged(current); },
    read(current) {
      if (!record || !record.unchanged(current)) return null;
      // Failed application must not consume recovery; release only on confirmed handoff.
      try { return clone(record.snapshot); } catch (_) { return null; }
    },
  };
}
