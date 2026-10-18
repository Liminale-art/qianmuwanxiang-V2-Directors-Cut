// Deferred user navigation only. Keep immutable identities, not DOM elements or
// mutable character indexes; never replay clicks or retry a native operation.
const validName = value => typeof value === 'string' && value.trim().length > 0 && !/[\\/\u0000-\u001f]/.test(value);
const key = value => (typeof value === 'string' && value.length > 0
  || typeof value === 'number' && Number.isFinite(value)) ? String(value) : null;
const indexOf = value => /^(?:0|[1-9][0-9]*)$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

function character(context, avatar) {
  if (!Array.isArray(context?.characters)) return null;
  const matches = context.characters.map((item, index) => ({ item, index })).filter(({ item }) => item?.avatar === avatar);
  return matches.length === 1 && validName(matches[0].item.chat) ? matches[0] : null;
}

function group(context, id) {
  if (!Array.isArray(context?.groups)) return null;
  const matches = context.groups.filter(item => key(item?.id) === id);
  return matches.length === 1 && validName(matches[0].chat_id) ? matches[0] : null;
}

function owner(context) {
  const groupId = key(context?.groupId);
  if (groupId !== null) {
    const item = group(context, groupId);
    return item && context.chatId === item.chat_id ? { kind: 'group', id: groupId, chatId: item.chat_id } : null;
  }
  const index = indexOf(context?.characterId), selected = index === null ? null : context?.characters?.[index];
  const resolved = validName(selected?.avatar) && character(context, selected.avatar);
  return resolved && context.chatId === selected.chat
    ? { kind: 'character', avatar: selected.avatar, chatId: selected.chat } : null;
}

const sameOwner = (left, right) => !!left && !!right && left.kind === right.kind
  && (left.kind === 'group' ? left.id === right.id : left.avatar === right.avatar);
const sameSource = (left, right) => sameOwner(left, right) && left.chatId === right.chatId;

export function createDirectorNavigation({ getContext, host, loadMain, loadGroups, confirmNew, hideHistory } = {}) {
  if (typeof getContext !== 'function' || typeof host?.ready !== 'function' || typeof host?.assertIdle !== 'function'
    || typeof host?.closeChat !== 'function') throw new TypeError('推演导航保护未就绪');
  const captured = new WeakSet(), consumed = new WeakSet();
  const context = () => { try { return getContext(); } catch (_) { return null; } };

  function capture(raw) {
    try {
      const current = context(), source = owner(current);
      if (!source || !raw || !['close', 'character', 'group', 'history', 'new'].includes(raw.kind)) return null;
      const intent = { kind: raw.kind, source: Object.freeze(source) };
      if (raw.kind === 'character') {
        const index = indexOf(raw.id), item = index === null ? null : current.characters?.[index];
        const resolved = validName(item?.avatar) && character(current, item.avatar);
        if (!resolved) return null;
        intent.target = Object.freeze({ avatar: item.avatar, chatId: item.chat });
      } else if (raw.kind === 'group') {
        const id = key(raw.id), item = id !== null && group(current, id);
        if (!item) return null;
        intent.target = Object.freeze({ id, chatId: item.chat_id });
      } else if (raw.kind === 'history') {
        if (!validName(raw.file)) return null;
        if (source.kind === 'group' && !group(current, source.id)?.chats?.includes(raw.file)) return null;
        intent.file = raw.file;
      } else if (raw.kind === 'new') {
        if (typeof raw.confirm !== 'boolean') return null;
        intent.confirm = raw.confirm;
      }
      Object.freeze(intent); captured.add(intent);
      return intent;
    } catch (_) { return null; }
  }

  function targetExists(intent, current) {
    if (intent.kind === 'character') return character(current, intent.target.avatar)?.item.chat === intent.target.chatId;
    if (intent.kind === 'group') return group(current, intent.target.id)?.chat_id === intent.target.chatId;
    if (intent.kind === 'history' && intent.source.kind === 'group') return group(current, intent.source.id)?.chats?.includes(intent.file) === true;
    return true;
  }

  function canInvoke(intent, isCurrent) {
    if (typeof isCurrent !== 'function' || isCurrent() !== true) return false;
    host.assertIdle();
    const current = context();
    return sameSource(owner(current), intent.source) && targetExists(intent, current);
  }

  async function navigate(intent, { isCurrent } = {}) {
    if (!intent || !captured.has(intent) || consumed.has(intent)) return 'unavailable';
    consumed.add(intent);
    await host.ready();
    if (!canInvoke(intent, isCurrent)) return 'unavailable';
    let main, groups, result;
    if (intent.kind === 'close') {
      result = await host.closeChat();
    } else {
      if (intent.kind === 'group' || intent.kind === 'history' && intent.source.kind === 'group') {
        if (typeof loadGroups !== 'function') return 'unavailable';
        groups = await loadGroups();
      } else {
        if (typeof loadMain !== 'function') return 'unavailable';
        main = await loadMain();
      }
      if (!canInvoke(intent, isCurrent)) return 'unavailable';
      if (intent.kind === 'character') {
        if (typeof main?.selectCharacterById !== 'function') return 'unavailable';
        // Re-resolve the index only after all asynchronous preparation.
        const target = character(context(), intent.target.avatar);
        if (!target) return 'unavailable';
        result = await main.selectCharacterById(target.index);
      } else if (intent.kind === 'group') {
        if (typeof groups?.openGroupById !== 'function') return 'unavailable';
        result = await groups.openGroupById(intent.target.id);
      } else if (intent.kind === 'history') {
        if (intent.source.kind === 'group') {
          if (typeof groups?.openGroupChat !== 'function') return 'unavailable';
          result = await groups.openGroupChat(intent.source.id, intent.file);
        } else {
          if (typeof main?.getPastCharacterChats !== 'function' || typeof main?.openCharacterChat !== 'function') return 'unavailable';
          const source = character(context(), intent.source.avatar);
          if (!source) return 'unavailable';
          // ST would create an empty chat if this history entry disappeared.
          // This is a read-only presence check, never a reconstructed save.
          const entries = await main.getPastCharacterChats(source.index);
          const exists = Array.isArray(entries) && entries.some(item => item?.file_id === intent.file
            || item?.file_name === `${intent.file}.jsonl`);
          if (!exists || !canInvoke(intent, isCurrent)) return 'unavailable';
          result = await main.openCharacterChat(intent.file);
        }
      } else if (intent.kind === 'new') {
        if (typeof main?.doNewChat !== 'function') return 'unavailable';
        if (intent.confirm) {
          if (typeof confirmNew !== 'function') return 'unavailable';
          if (await confirmNew() !== true) return 'cancelled';
          if (!canInvoke(intent, isCurrent)) return 'unavailable';
        }
        // Keep the previous chat for both character and group creation.
        result = await main.doNewChat({ deleteCurrentChat: false });
      }
    }

    // Native methods often return void, including on refusal. Verify the
    // destination, not the old-source guard that navigation itself invalidates.
    // Unlike the void-returning switch/new helpers, close has an explicit
    // success result; preserve the established close-confirmation contract.
    if (intent.kind === 'close') return result === true ? 'completed' : 'unavailable';
    if (result === false) return 'unavailable';
    const current = context(), destination = owner(current);
    let completed = false;
    if (intent.kind === 'character') completed = destination?.kind === 'character'
      && destination.avatar === intent.target.avatar && destination.chatId === intent.target.chatId;
    else if (intent.kind === 'group') completed = destination?.kind === 'group'
      && destination.id === intent.target.id && destination.chatId === intent.target.chatId;
    else if (intent.kind === 'history') completed = sameOwner(destination, intent.source) && destination.chatId === intent.file;
    else if (intent.kind === 'new') completed = sameOwner(destination, intent.source) && destination.chatId !== intent.source.chatId;
    if (!completed) return 'unavailable';
    if (intent.kind === 'history' || intent.kind === 'new' && !intent.confirm) {
      try { hideHistory?.(); } catch (_) { /* The navigation already completed. */ }
    }
    return 'completed';
  }

  return Object.freeze({ capture, navigate });
}
