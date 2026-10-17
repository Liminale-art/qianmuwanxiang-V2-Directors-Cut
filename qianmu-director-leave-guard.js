// Narrow UI protection, not a host save lock or a persistence receipt.
// ST 1.19: script.js binds #options [id] / .character_select; bookmarks.js
// binds .select_chat_block; group-chats.js binds .group_select using data-chid
// or data-grid. keyboard.js invokes element.click(), so synthetic
// click/detail=0 must remain eligible. Slash/API calls and navigation already
// started before this listener/run are intentionally outside this protection.
const historyTools = '.renameChatButton, .exportChatButton, .exportRawChatButton, .PastChat_cross';
const fail = message => { throw Object.assign(new Error(message), { code: 'director_leave_guard' }); };
const isOwner = value => value !== null && ['object', 'function', 'symbol'].includes(typeof value);

export function createDirectorLeaveGuard({ document, getContext, notify = () => {}, now = Date.now } = {}) {
  if (typeof document?.addEventListener !== 'function' || typeof document?.removeEventListener !== 'function'
    || typeof getContext !== 'function' || typeof notify !== 'function' || typeof now !== 'function') fail('推演离开保护未就绪');
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
  function onClick(event) {
    if (!attached || !intent(event)) return;
    const record = active;
    if (record?.saving) {
      event.preventDefault(); event.stopImmediatePropagation();
      const at = now();
      if (record.notifiedAt === null || at < record.notifiedAt || at - record.notifiedAt >= 1500) {
        record.notifiedAt = at;
        try { notify('正在保存，请稍候再切换或关闭聊天。', 'warning'); } catch (_) {}
      }
      return;
    }
    navigationEpoch++;
    if (record) cancel(record);
  }
  document.addEventListener('click', onClick, true);
  return Object.freeze({
    begin(owner, onLeave) {
      if (disposed || !attached || active || !isOwner(owner) || typeof onLeave !== 'function') fail('推演离开保护尚未释放');
      const ticket = Object.freeze({});
      active = { owner, ticket, epoch: navigationEpoch, onLeave, cancelled: false, saving: false, notifiedAt: null };
      return ticket;
    },
    acquire(ticket) {
      if (disposed || !attached || !active || active.ticket !== ticket || active.cancelled || active.epoch !== navigationEpoch) return false;
      active.saving = true;
      return true;
    },
    release(ticket) {
      if (!active || active.ticket !== ticket) return false;
      active = null;
      if (disposed) detach();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Do not drop an in-flight owner's protection just because Q is disabled
      // or its UI is being disposed. Only its eventual release can remove it.
      if (active?.saving) return;
      if (active) cancel(active);
      active = null; detach();
    },
  });
}
