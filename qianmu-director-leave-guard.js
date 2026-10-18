// Narrow UI protection, not a host save lock or a persistence receipt.
// ST 1.19: script.js binds #options [id] / .character_select; bookmarks.js
// binds .select_chat_block; group-chats.js binds .group_select using data-chid
// or data-grid. keyboard.js invokes element.click(), so synthetic
// click/detail=0 must remain eligible. Slash/API calls and navigation already
// started before this listener/run are intentionally outside this protection.
const historyTools = '.renameChatButton, .exportChatButton, .exportRawChatButton, .PastChat_cross';
const fail = message => { throw Object.assign(new Error(message), { code: 'director_leave_guard' }); };
const isOwner = value => value !== null && ['object', 'function', 'symbol'].includes(typeof value);

export function createDirectorLeaveGuard({ document, getContext, isHostGenerating = () => null, onNavigate = () => {}, notify = () => {}, now = Date.now } = {}) {
  if (typeof document?.addEventListener !== 'function' || typeof document?.removeEventListener !== 'function'
    || typeof getContext !== 'function' || typeof isHostGenerating !== 'function' || typeof onNavigate !== 'function'
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
    if (close?.closest('#options')) return 'close';
    const group = element.closest('.group_select');
    if (group) {
      const id = group.getAttribute('data-chid') || group.getAttribute('data-grid');
      if (!id) return '';
      let context;
      try { context = getContext(); } catch (_) { /* Unknown live state: protect a potential group switch. */ }
      if (context?.groupId !== undefined && context.groupId !== null && String(context.groupId) === id) return '';
      return 'group';
    }
    const character = element.closest('.character_select');
    if (character) {
      const id = character.getAttribute('data-chid');
      if (typeof id !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(id)) return '';
      let context;
      try { context = getContext(); } catch (_) { /* Unknown live state: do not assume this is the same character. */ }
      if (context && (context.groupId === undefined || context.groupId === null || context.groupId === '')
        && String(context.characterId) === id) return '';
      return 'character';
    }
    const history = element.closest('.select_chat_block');
    if (history && !element.closest(historyTools) && history.getAttribute('file_name')) return 'history';
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
    const kind = intent(event);
    if (!kind) return;
    const record = active;
    const hostState = kind === 'close' ? hostGenerationState() : false;
    if (record?.saving) {
      stop(event);
      if (kind === 'close' && !disposed && !record.finishing && hostState === false) {
        if (!record.pendingClose) {
          record.pendingClose = true;
          // Cancel a queued automatic inference now, not after native close.
          // Do not invalidate the saving owner's source/navigation epoch.
          navigation('close');
        }
        notice(record, '正在保存，完成后将自动关闭聊天。');
      } else {
        notice(record, kind === 'close' && hostState !== false
          ? '正文尚未结束，暂不能关闭聊天。' : '正在保存，请稍候再切换聊天。');
      }
      return;
    }
    if (kind === 'close' && hostState !== false) {
      // ST refuses close while generating. Do not cancel Q before that refusal.
      // If the host state cannot be established, preserve an active Q run too.
      if (record && hostState === null) { stop(event); notice(record, '暂无法确认正文状态，请稍后关闭聊天。'); }
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
        pendingClose: false, finishing: false, finishPromise: null };
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
    hasPendingClose(ticket) { return !!active && active.ticket === ticket && active.pendingClose; },
    finish(ticket, { confirmed = false, isCurrent, closeChat } = {}) {
      const record = active;
      if (!record || record.ticket !== ticket) return Promise.resolve(false);
      if (record.finishing) return record.finishPromise;
      record.finishing = true;
      record.finishPromise = Promise.resolve().then(async () => {
        const requested = record.pendingClose;
        record.pendingClose = false;
        try {
          if (!requested || !record.saving || confirmed !== true || disposed || record.cancelled
            || typeof isCurrent !== 'function' || typeof closeChat !== 'function') return false;
          if (hostGenerationState() !== false) {
            try { notify('正文尚未结束，暂未关闭聊天。', 'warning'); } catch (_) {}
            return false;
          }
          // Keep this source check synchronous and immediately adjacent to the
          // native close call. Native close may await before clearing the chat;
          // the saving guard remains held for that whole promise, without a timer.
          if (isCurrent() !== true) return false;
          const closed = await closeChat();
          if (closed !== true) {
            try { notify('保存已确认，但聊天未能自动关闭。', 'warning'); } catch (_) {}
          }
          return closed === true;
        } catch (_) {
          try { notify('保存已确认，但聊天未能自动关闭。', 'warning'); } catch (_) {}
          return false;
        } finally { release(record); }
      });
      return record.finishPromise;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (active) active.pendingClose = false;
      // Do not drop an in-flight owner's protection just because Q is disabled
      // or its UI is being disposed. Only its eventual release can remove it.
      if (active?.saving) return;
      if (active) cancel(active);
      active = null; detach();
    },
  });
}
