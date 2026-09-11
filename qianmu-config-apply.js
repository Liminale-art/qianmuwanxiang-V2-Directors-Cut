// Synchronous configuration handoff only; independent originals are never read/deleted.
// `save` schedules host persistence. Its return is NOT a durable-write acknowledgement.
export function applyPreparedConfig({prepared, owner, host, slot, setCurrent, save,
  layoutStorage, layoutKey, now = Date.now}) {
  let hadSlot, previous, storage, rawLayout, nextLayout;
  try {
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared) || prepared === owner) throw Error();
    hadSlot = Object.hasOwn(host, slot);
    previous = host[slot];
    if (hadSlot && previous !== owner) throw Error();
    if (prepared.proseLayout && typeof prepared.proseLayout === 'object' && !Array.isArray(prepared.proseLayout)) {
      storage = layoutStorage();
      if (storage) {
        rawLayout = storage.getItem(layoutKey);
        prepared.proseLayout.updatedAt = now();
        nextLayout = JSON.stringify(prepared.proseLayout);
      }
    }
  } catch (_) { return {status:'rejected', persistence:'not-requested'}; }

  let hostTouched = false, liveTouched = false, cacheTouched = false, saveAttempted = false;
  try {
    hostTouched = true; host[slot] = prepared;
    liveTouched = true; setCurrent(prepared);
    if (storage) { cacheTouched = true; storage.setItem(layoutKey, nextLayout); }
    saveAttempted = true; save();
    return {status:'applied', persistence:'requested'};
  } catch (_) {
    // Restore every touched target independently, even if a previous compensation fails.
    let complete = true;
    const attempt = action => { try { action(); } catch (_) { complete = false; } };
    if (cacheTouched) attempt(() => rawLayout === null ? storage.removeItem(layoutKey) : storage.setItem(layoutKey, rawLayout));
    if (hostTouched) attempt(() => { if (hadSlot) host[slot] = previous; else delete host[slot]; });
    if (liveTouched) attempt(() => setCurrent(owner));
    // A throwing save may already have queued a write. Re-schedule only fully restored state.
    if (saveAttempted && complete) attempt(save);
    return {status:complete ? 'reverted' : 'incomplete', persistence:saveAttempted ? 'uncertain' : 'not-requested'};
  }
}
