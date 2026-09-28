import {captureCurrentChatSource} from './qianmu-current-chat-source.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function timestamp(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    // Host timestamps are weak anchors, not dates to interpret or permission
    // evidence. Keep legacy ST strings ("2026-9-28 @12h ...") verbatim too.
    return typeof value === 'string' && value.trim() && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

export function collectionSourceKey(source) {
    if (!object(source) || Object.keys(source).length !== 2
        || typeof source.chatId !== 'string' || !source.chatId.trim()
        || typeof source.messageId !== 'string' || !source.messageId.trim()) return null;
    return JSON.stringify([source.chatId, source.messageId]);
}

/** Read-only, optional floor links, NOT permanent chat/message UUIDs.
 * File rename, first-swipe deletion, replacement/import and ambiguous timestamps
 * may lose a link. They never migrate, remove or change the saved collection.
 * Account ownership is supplied by the caller's collection session, not this key.
 */
export function textCollectionFloorSources(context) {
    const result = new Map();
    if (!object(context)) return result;
    const host = {...context, eventTypes: context.eventTypes || context.event_types};
    let captured, chatId;
    try {
        captured = captureCurrentChatSource({getContext: () => host, epoch: () => 0});
        captured.assertCurrent();
        chatId = JSON.stringify([captured.target.kind, captured.source.ownerKey, captured.target.chatId, captured.integrity]);
    } catch { return result; }
    finally { captured?.close(); }

    const candidates = new Map();
    for (const message of host.chat) {
        // is_system is ST's prompt-exclusion flag. It is not a collection role
        // or source identity, so toggling it must never unlink a saved floor.
        if (!object(message) || typeof message.is_user !== 'boolean') continue;
        const first = Array.isArray(message.swipe_info) ? message.swipe_info[0] : null;
        const sent = timestamp(first?.send_date) || timestamp(message.send_date);
        if (!sent) continue;
        // Names, active swipe, generation IDs and prose can change on an edit or
        // continuation. The first saved timestamp names only a weak family.
        const messageId = JSON.stringify([message.is_user ? 'user' : 'assistant', sent]);
        if (candidates.has(messageId)) candidates.set(messageId, null);
        else candidates.set(messageId, message);
    }
    for (const [messageId, message] of candidates) {
        if (message) result.set(message, Object.freeze({chatId, messageId}));
    }
    return result;
}
