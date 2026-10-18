// Narrow UI protection, not a host save lock or a persistence receipt.
// ST 1.19: script.js binds #options [id] / .character_select; bookmarks.js
// binds .select_chat_block; group-chats.js binds .group_select using data-chid
// or data-grid. keyboard.js invokes element.click(), so synthetic
// click/detail=0 must remain eligible. Slash/API calls and navigation already
// started before this listener/run are intentionally outside this protection.
const historyTools = '.renameChatButton, .exportChatButton, .exportRawChatButton, .PastChat_cross';
const fail = message => { throw Object.assign(new Error(message), { code: 'director_leave_guard' }); };
const isOwner = value => value !== null && ['object', 'function', 'symbol'].includes(typeof value);
const captureClose = intent => intent.kind === 'close' ? Object.freeze({ kind: 'close' }) : null;

export function createDirectorLeaveGuard({ document, getContext, isHostGenerating = () => null, captureIntent = captureClose, onNavigate = () => {}, notify = () => {}, now = Date.now } = {}) {
  if (typeof document?.addEventListener !== 'function' || typeof document?.removeEventListener !== 'function'
    || typeof getContext !== 'function' || typeof isHostGenerating !== 'function' || typeof captureIntent !== 'function' || typeof onNavigate !== 'function'
    || typeof notify !== 'function' || typeof now !== 'function') fail('推演离开保护未就绪');
  let active = null, navigationEpoch = 0, disposed = false, attached = true;
  const detach = () => {
    if (!attached) return;
    document.removeEventListener('click', onClick, true); attached = false;
  };
  function intent(event) {
    // preventDefault alone does not stop ST's explicit jQuery click handlers.
    if (event?.type !== 'click' || event.button !== undefined && event.button !== 0) return '';
    const element = typeof event.target?.closest === 'function' ? event.target : event.target?.parentElement;
    if (typeof element?.closest !== 'function') return '';
    const close = element.closest('#option_close_chat');
    if (close?.closest('#options')) return { kind: 'close' };
    const newChat = element.closest('#option_start_new_chat');
    if (newChat?.closest('#options')) return { kind: 'new', confirm: true };
    if (element.closest('#newChatFromManageScreenButton')) return { kind: 'new', confirm: false };
    const group = element.closest('.group_select');
    if (group) {
      const id = group.getAttribute('data-chid') || group.getAttribute('data-grid');
      if (!id) return '';
      let context;
      try { context = getContext(); } catch (_) { /* Unknown live state: protect a potential group switch. */ }
      if (context?.groupId !== undefined && context.groupId !== null && String(context.groupId) === id) return '';
      return { kind: 'group', id };
    }
    const character = element.closest('.character_select');
    if (character) {
      const id = character.getAttribute('data-chid');
      if (typeof id !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(id)) return '';
      let context;
      try { context = getContext(); } catch (_) { /* Unknown live state: do not assume this is the same character. */ }
      if (context && (context.groupId === undefined || context.groupId === null || context.groupId === '')
        && String(context.characterId) === id) return '';
      return { kind: 'character', id };
    }
    const history = element.closest('.select_chat_block');
    if (history && !element.closest(historyTools) && history.getAttribute('file_name')) return { kind: 'history', file: history.getAttribute('file_name') };
    return '';
  }
  function cancel(record) {
    if (record.cancelled) return;
    record.cancelled = true;
    // Admission is already invalidated even if a caller callback throws. A
    // broken cancel callback must not stop the user's ordinary navigation.
    try { const result = record.onLeave(); if (result?.then) void Promise.resolve(result).catch(() => {}); } catch (_) {}
  }
  function hostGenerationState() {
    try { const value = isHostGenerating(); return typeof value === 'boolean' ? value : null; } catch (_) { return null; }
  }
  function navigation(kind) {
    try { const result = onNavigate(kind); if (result?.then) void Promise.resolve(result).catch(() => {}); } catch (_) {}
  }
  function stop(event) { event.preventDefault(); event.stopImmediatePropagation(); }
  function notice(record, message) {
    const at = now();
    if (record.notifiedAt === null || at < record.notifiedAt || at - record.notifiedAt >= 1500) {
      record.notifiedAt = at;
      try { notify(message, 'warning'); } catch (_) {}
    }
  }
  function release(record) {
    if (active !== record) return false;
    active = null;
    if (disposed) detach();
    return true;
  }
  function onClick(event) {
    if (!attached) return;
    const requested = intent(event);
    if (!requested) return;
    const { kind } = requested;
    const record = active;
    const hostState = hostGenerationState();
    if (record?.saving) {
      stop(event);
      // Once execution begins, later clicks must not redirect the operation
      // while its native confirmation or navigation is still in progress.
      if (disposed || record.finishing) {
        notice(record, '正在完成聊天操作，请稍候。');
        return;
      }
      if (hostState !== false) {
        record.pendingIntent = null; record.pendingKey = '';
        notice(record, '正文尚未结束，暂不能切换聊天。');
        return;
      }
      let captured, key;
      try {
        captured = captureIntent(Object.freeze(requested));
        if (!captured || !Object.isFrozen(captured) || captured.kind !== kind
          || ![Object.prototype, null].includes(Object.getPrototypeOf(captured))) captured = null;
        key = captured ? JSON.stringify(captured) : '';
      } catch (_) { captured = null; }
      if (!captured || !key) {
        // The latest choice was not safe to capture. Never execute an older
        // destination that the user has just tried to replace.
        record.pendingIntent = null; record.pendingKey = '';
        notice(record, '暂无法确认目标聊天，保存后请重试。');
        return;
      }
      const changed = key !== record.pendingKey;
      record.pendingIntent = captured; record.pendingKey = key;
      // Cancel queued automatic inference now without invalidating this save's
      // source. Keep just the latest destination, not a queue of future clicks.
      if (changed) navigation(kind);
      notice(record, kind === 'close' ? '正在保存，完成后将自动关闭聊天。' : '正在保存，完成后将继续聊天操作。');
      return;
    }
    if (hostState !== false) {
      // Host busy also includes streaming tail work after its send flag clears;
      // native navigation gates alone do not cover that window. Protect every
      // recognized navigation while Q owns a run, without becoming a global
      // ST UI lock when no Q task is active.
      if (record) {
        stop(event);
        notice(record, hostState === null ? '暂无法确认正文状态，请稍后切换聊天。' : '正文尚未结束，暂不能切换聊天。');
      }
      return;
    }
    navigationEpoch++;
    navigation(kind);
    if (record) cancel(record);
  }
  document.addEventListener('click', onClick, true);
  return Object.freeze({
    begin(owner, onLeave) {
      if (disposed || !attached || active || !isOwner(owner) || typeof onLeave !== 'function') fail('推演离开保护尚未释放');
      const ticket = Object.freeze({});
      active = { owner, ticket, epoch: navigationEpoch, onLeave, cancelled: false, saving: false, notifiedAt: null,
        pendingIntent: null, pendingKey: '', finishing: false, finishPromise: null };
      return ticket;
    },
    acquire(ticket) {
      if (disposed || !attached || !active || active.ticket !== ticket || active.cancelled || active.epoch !== navigationEpoch) return false;
      active.saving = true;
      return true;
    },
    release(ticket) {
      if (!active || active.ticket !== ticket || active.finishing) return false;
      return release(active);
    },
    hasPendingNavigation(ticket) { return !!active && active.ticket === ticket && !!active.pendingIntent; },
    finish(ticket, { confirmed = false, isCurrent, navigate } = {}) {
      const record = active;
      if (!record || record.ticket !== ticket) return Promise.resolve(false);
      if (record.finishing) return record.finishPromise;
      record.finishing = true;
      record.finishPromise = Promise.resolve().then(async () => {
        const requested = record.pendingIntent;
        record.pendingIntent = null; record.pendingKey = '';
        try {
          if (!requested || !record.saving || confirmed !== true || disposed || record.cancelled
            || typeof isCurrent !== 'function' || typeof navigate !== 'function') return false;
          if (hostGenerationState() !== false) {
            try { notify('正文尚未结束，暂未继续聊天操作。', 'warning'); } catch (_) {}
            return false;
          }
          const stillCurrent = () => {
            try { return !disposed && active === record && !record.cancelled && isCurrent() === true; } catch (_) { return false; }
          };
          // The adapter rechecks this callback and host idleness after each
          // awaited import/confirmation, before invoking a native operation.
          // Keep capture protection held until its entire promise finishes.
          if (!stillCurrent()) return false;
          const result = await navigate(requested, { isCurrent: stillCurrent });
          if (result !== 'completed' && result !== 'cancelled') {
            try { notify('保存已确认，但未能继续切换聊天。', 'warning'); } catch (_) {}
          }
          return result === 'completed';
        } catch (_) {
          try { notify('保存已确认，但未能继续切换聊天。', 'warning'); } catch (_) {}
          return false;
        } finally { release(record); }
      });
      return record.finishPromise;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (active) { active.pendingIntent = null; active.pendingKey = ''; }
      // Do not drop an in-flight owner's protection just because Q is disabled
      // or its UI is being disposed. Only its eventual release can remove it.
      if (active?.saving) return;
      if (active) cancel(active);
      active = null; detach();
    },
  });
}
