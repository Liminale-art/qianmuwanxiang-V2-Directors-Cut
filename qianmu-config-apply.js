// Synchronous configuration handoff only; independent originals are never read/deleted.
// `save` schedules host persistence. Its return is NOT a durable-write acknowledgement.
export function applyPreparedConfig({prepared, owner, host, slot, setCurrent, save,
  layoutStorage, layoutKey, now = Date.now, undo, layoutSnapshot}) {
  let hadSlot, previous, storage, rawLayout, nextLayout, recovery, writeLayout = false;
  try {
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared) || prepared === owner) throw Error();
    hadSlot = Object.hasOwn(host, slot);
    previous = host[slot];
    if (hadSlot && previous !== owner) throw Error();
    const hasLayout = prepared.proseLayout && typeof prepared.proseLayout === 'object' && !Array.isArray(prepared.proseLayout);
    if (layoutSnapshot !== undefined && (!layoutSnapshot || typeof layoutSnapshot.available !== 'boolean'
      || (layoutSnapshot.available && layoutSnapshot.raw !== null && typeof layoutSnapshot.raw !== 'string'))) throw Error();
    if (hasLayout || undo || layoutSnapshot?.available) {
      storage = layoutStorage();
      if (storage) rawLayout = storage.getItem(layoutKey);
      if (layoutSnapshot?.available) {
        if (!storage) throw Error();
        nextLayout = layoutSnapshot.raw;
        writeLayout = true;
      } else if (storage && hasLayout && layoutSnapshot === undefined) {
        prepared.proseLayout.updatedAt = now();
        nextLayout = JSON.stringify(prepared.proseLayout);
        writeLayout = true;
      }
    }
    if (undo) {
      if (typeof undo.remember !== 'function' || typeof undo.clear !== 'function') throw Error();
      recovery = {settings:structuredClone(owner),layout:{available:!!storage,raw:storage ? rawLayout : null},
        layoutAfter:{available:!!storage,raw:storage ? (writeLayout ? nextLayout : rawLayout) : null}};
    }
  } catch (_) { return {status:'rejected', persistence:'not-requested'}; }

  let hostTouched = false, liveTouched = false, cacheTouched = false, saveAttempted = false;
  try {
    hostTouched = true; host[slot] = prepared;
    liveTouched = true; setCurrent(prepared);
    if (writeLayout) { cacheTouched = true; if (nextLayout === null) storage.removeItem(layoutKey); else storage.setItem(layoutKey, nextLayout); }
    saveAttempted = true; save();
    if (undo && !undo.remember(recovery,prepared)) throw Error('撤回记录准备失败');
    return {status:'applied', persistence:'requested'};
  } catch (_) {
    // Restore every touched target independently, even if a previous compensation fails.
    let complete = true;
    const attempt = action => { try { action(); } catch (_) { complete = false; } };
    if (undo) attempt(() => undo.clear());
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
    try {
      if (effect === options.render && options.undo) await options.undo.transition(options.current, effect);
      else await effect();
    } catch (_) { viewFailed = true; }
  }
  if (options.current() !== options.prepared) return {...result, view:'stale'};
  options.notify(viewFailed ? '配置已应用，但页面更新未完成，请重新打开千幕检查。' : options.action === 'undo' ? '已撤回本次配置恢复。' : '配置已导入并覆盖。', viewFailed ? 'warning' : 'success');
  return {...result, view:viewFailed ? 'incomplete' : 'updated'};
}
