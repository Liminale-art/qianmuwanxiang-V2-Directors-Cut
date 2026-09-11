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

// Derived caches/views are updated only after the configuration handoff succeeds.
// A view error must never masquerade as an unapplied import or trigger a second import.
export async function finishConfigRestore(options) {
  const result = applyPreparedConfig(options);
  if (result.status !== 'applied') {
    const messages = {
      rejected:'配置未应用，当前设置未改变。请检查储存状态后重试。',
      reverted:result.persistence === 'uncertain' ? '当前页面已恢复原配置；保存结果未确认，请先导出备份并检查。' : '配置未应用，已恢复原状态。',
      incomplete:'配置恢复未完成，部分状态未能还原；请勿继续覆盖，先导出备份并检查。',
    };
    options.notify(messages[result.status], 'error');
    return result;
  }
  let viewFailed = false;
  for (const effect of [options.afterApply, options.inject, options.render]) {
    if (options.current() !== options.prepared) return {...result, view:'stale'};
    try { await effect(); } catch (_) { viewFailed = true; }
  }
  if (options.current() !== options.prepared) return {...result, view:'stale'};
  options.notify(viewFailed ? '配置已应用，但页面更新未完成，请重新打开千幕检查。' : '配置已导入并覆盖。', viewFailed ? 'warning' : 'success');
  return {...result, view:viewFailed ? 'incomplete' : 'updated'};
}
