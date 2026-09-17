import { chatFileTarget } from './qianmu-chat-file-target.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'current_chat_source' }); };
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function snapshot(getContext, epoch) {
    const context = getContext(), revision = epoch();
    if (!object(context) || !Array.isArray(context.chat) || !object(context.chatMetadata) || !Number.isSafeInteger(revision) || revision < 0
        || typeof context.chatId !== 'string' || !context.chatId) fail('请先打开一个已定位的聊天，未使用角色编号或默认聊天兜底');
    let target, hostId, ownerKey;
    if (context.groupId !== null && context.groupId !== undefined && context.groupId !== '') {
        const id = context.groupId;
        if (!(Number.isSafeInteger(id) && id >= 0 || typeof id === 'string' && id === id.trim() && id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(id)) || !Array.isArray(context.groups)) fail('群聊定位尚未就绪');
        hostId = String(id); const matches = context.groups.filter(row => row && String(row.id) === hostId);
        if (matches.length !== 1 || matches[0].chat_id !== context.chatId) fail('当前群组和聊天文件不一致');
        target = chatFileTarget({ kind: 'group', chatId: context.chatId }); ownerKey = 'group:' + hostId;
    } else {
        const id = context.characterId;
        if (!(Number.isSafeInteger(id) && id >= 0 || typeof id === 'string' && /^(?:0|[1-9][0-9]*)$/.test(id) && Number.isSafeInteger(Number(id))) || !Array.isArray(context.characters)) fail('当前角色定位尚未就绪');
        const character = context.characters[id]; hostId = String(id);
        if (!object(character) || character.chat !== context.chatId) fail('当前角色和聊天文件不一致');
        target = chatFileTarget({ kind: 'character', chatId: context.chatId, avatar: character.avatar });
        if (context.characters.filter(row => row?.avatar === target.avatar).length !== 1) fail('当前角色文件标识重复，不能猜测来源');
        ownerKey = 'char:' + target.avatar;
    }
    // ST supplies this value; we never mint, persist or treat it as a globally unique chat ID.
    // Missing legacy values remain missing, and cloned/imported chats may share one.
    const integrity = context.chatMetadata.integrity ?? null;
    if (integrity !== null && (typeof integrity !== 'string' || integrity.length > 512 || /[\u0000-\u001f\u007f]/.test(integrity))) fail('聊天完整性标记格式异常，请核对原聊天');
    return { target, hostId, ownerKey, integrity, revision, messages: context.chat, metadata: context.chatMetadata,
        store: context.chatMetadata.story_director_liminale, eventSource: context.eventSource, eventTypes: context.eventTypes };
}

// Events invalidate a borrowed scope; they never prove a new location or authorize deletion.
// ST 1.19's rename event may contain the pre-sanitized request name; deletion omits owner identity.
function affects(captured, kind, value) {
    const target = captured.target;
    if (kind === 'changed') return true;
    if (kind === 'deleted' || kind === 'groupDeleted') {
        if ((kind === 'groupDeleted') !== (target.kind === 'group')) return false;
        return typeof value !== 'string' || !value || value === target.chatId;
    }
    if (!object(value) || typeof value.oldFileName !== 'string' || !value.oldFileName) return true;
    if (value.oldFileName !== target.chatId + '.jsonl') return false;
    const group = value.groupId !== null && value.groupId !== undefined && value.groupId !== '';
    if (group) {
        if (!(typeof value.groupId === 'string' || Number.isSafeInteger(value.groupId))) return true;
        return target.kind === 'group' && String(value.groupId) === captured.hostId;
    }
    if (typeof value.avatarId === 'string' && value.avatarId) return target.kind === 'character' && value.avatarId === target.avatar;
    return true; // Same name but no trustworthy owner: stop only this scope, don't alter any data.
}

// One shared host locator for scoped saves and future gallery indexing. This is a lifetime guard,
// not a server receipt, lock, permanent identity, rename map, or ownership grant.
export function captureCurrentChatSource({ getContext, epoch } = {}) {
    if (typeof getContext !== 'function' || typeof epoch !== 'function') fail('聊天来源缺少宿主定位和切换保护');
    let captured = snapshot(getContext, epoch); const bindings = [];
    let closed = false, invalidated = false;
    const source = captured.eventSource, remove = typeof source?.removeListener === 'function' ? source.removeListener : source?.off;
    const release = () => {
        for (const [type, handler] of bindings.splice(0)) { try { remove.call(source, type, handler); } catch (_) { /* Scope remains invalid. */ } }
    };
    const invalidate = () => { invalidated = true; release(); captured = null; };
    if (typeof source?.on === 'function' && typeof remove === 'function') {
        const events = [['CHAT_CHANGED', 'chat_changed', 'changed'], ['CHAT_LOADED', 'chat_loaded', 'loaded'],
            ['CHAT_RENAMED', 'chat_renamed', 'renamed'], ['CHAT_DELETED', 'chat_deleted', 'deleted'], ['GROUP_CHAT_DELETED', 'group_chat_deleted', 'groupDeleted']];
        try {
            for (const [name, fallback, kind] of events) {
                const type = captured.eventTypes?.[name] || fallback, handler = value => {
                    if (closed || invalidated) return;
                    // CHAT_LOADED follows CHAT_CHANGED in ST. A newly rendered, unchanged scope
                    // must survive that trailing notification; only actual evidence changes cancel it.
                    if (kind === 'loaded') { try { assertCurrent(); } catch (_) { invalidate(); } return; }
                    if (affects(captured, kind, value)) invalidate();
                };
                bindings.push([type, handler]); source.on(type, handler);
                if (invalidated) fail('订阅期间聊天来源已变化');
            }
        } catch (_) { invalidate(); fail('聊天来源通知未能订阅，原操作未启动'); }
    }
    function assertCurrent() {
        if (closed || invalidated) fail('当前聊天已切换、改名或删除，原来源会话作废');
        let now;
        try { now = snapshot(getContext, epoch); } catch (error) { invalidate(); throw error; }
        if (closed || invalidated) fail('核对期间聊天来源已变化');
        if (now.revision !== captured.revision || now.hostId !== captured.hostId || now.messages !== captured.messages || now.metadata !== captured.metadata
            || now.store !== captured.store || now.integrity !== captured.integrity || now.eventSource !== captured.eventSource
            || JSON.stringify(now.target) !== JSON.stringify(captured.target)) { invalidate(); fail('当前聊天已切换、替换或重载，原来源会话作废'); }
        return true;
    }
    return Object.freeze({ target: Object.freeze({ ...captured.target }),
        source: Object.freeze({ ownerKey: captured.ownerKey, chatKey: captured.target.chatId }), integrity: captured.integrity,
        assertCurrent, isCurrent() { try { return assertCurrent(); } catch (_) { return false; } },
        close() { closed = true; release(); captured = null; } });
}
