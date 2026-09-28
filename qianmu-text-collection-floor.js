import {qianmuIconElement} from './qianmu-icon-renderer.js';

export const TEXT_COLLECTION_FLOOR_STYLESHEET = new URL('./qianmu-text-collection-floor.css', import.meta.url);

const sourceKey = source => source && typeof source.chatId === 'string' && source.chatId
    && typeof source.messageId === 'string' && source.messageId
    ? JSON.stringify([source.chatId, source.messageId]) : null;

// This adapter only renders confirmed, page-owned collection state. It never
// reads storage or binds global events; the owner delegates its chat click.
export function createTextCollectionFloor({getContext, getSourceMap, getItems, onToggle, onError, applyIcons} = {}) {
    if ([getContext, getSourceMap, getItems, onToggle].some(fn => typeof fn !== 'function')) {
        throw new TypeError('Collection floor tools require their owner');
    }
    let root = null, epoch = 0, disposed = false;
    const records = new Map(), buttons = new Map(), pending = new Set();

    function clear() {
        epoch++;
        for (const {button} of records.values()) button.remove();
        records.clear(); buttons.clear(); pending.clear();
    }

    function messageAt(element, context) {
        const value = element.getAttribute('mesid');
        if (!/^(0|[1-9]\d*)$/.test(value ?? '')) return null;
        const floor = Number(value);
        return Number.isSafeInteger(floor) ? context.chat?.[floor] ?? null : null;
    }

    function snapshot() {
        const context = getContext() || {}, sources = getSourceMap(context);
        const ids = new Map();
        for (const item of getItems() || []) {
            const key = sourceKey(item.source);
            if (key === null) continue;
            if (!ids.has(key)) ids.set(key, []);
            ids.get(key).push(item.id);
        }
        return {context, sources, ids};
    }

    function paint(record, collected) {
        const busy = pending.has(record.message);
        if (record.collected !== collected) {
            record.collected = collected;
            const label = collected ? '取消本层收藏' : '收藏正文';
            record.button.title = label;
            record.button.setAttribute('aria-label', label);
            record.button.setAttribute('aria-pressed', String(collected));
            record.glyph?.setAttribute('fill', collected ? 'currentColor' : 'none');
        }
        if (record.busy !== busy) {
            record.busy = busy;
            record.button.disabled = busy;
            record.button.setAttribute('aria-busy', String(busy));
        }
    }

    function refresh(nextRoot = root) {
        if (disposed) return;
        if (nextRoot !== root) { clear(); root = nextRoot; }
        if (!root?.querySelectorAll) return;
        const state = snapshot(), seen = new Set();
        for (const element of root.querySelectorAll('.mes')) {
            const message = messageAt(element, state.context);
            if (!message || message.is_system) continue;
            const outer = element.querySelector('.mes_buttons');
            const toolbar = outer?.querySelector('.extraMesButtons') || outer?.querySelector('.mes_buttons_inner') || outer;
            if (!toolbar) continue;
            let record = records.get(element);
            if (!record || record.message !== message || !toolbar.contains(record.button)) {
                if (record) { record.button.remove(); buttons.delete(record.button); }
                const button = root.ownerDocument.createElement('button');
                button.type = 'button'; button.className = 'mes_button interactable qm-collection-star';
                const glyph = qianmuIconElement('qm-regular-star', {document: root.ownerDocument});
                if (glyph) button.appendChild(glyph);
                toolbar.appendChild(button);
                record = {button, glyph, message, element, collected: null, busy: null};
                records.set(element, record); buttons.set(button, record);
                applyIcons?.(button);
            }
            seen.add(element);
            const key = sourceKey(state.sources?.get(message));
            paint(record, key !== null && state.ids.has(key));
        }
        for (const [element, record] of records) {
            if (!seen.has(element)) {
                record.button.remove(); buttons.delete(record.button); records.delete(element);
            }
        }
    }

    function handleClick(event) {
        if (disposed || !root) return false;
        const target = event.target?.closest ? event.target : event.target?.parentElement;
        const button = target?.closest?.('button.qm-collection-star');
        const record = buttons.get(button);
        if (!record || !root.contains(button)) return false;
        event.preventDefault(); event.stopPropagation();
        if (pending.has(record.message)) return true;
        const state = snapshot();
        if (messageAt(record.element, state.context) !== record.message || record.message.is_system) {
            refresh(); return true;
        }
        const linkedSource = state.sources?.get(record.message), key = sourceKey(linkedSource);
        const source = key === null ? null : linkedSource;
        const ids = key === null ? [] : [...(state.ids.get(key) || [])];
        const operationEpoch = epoch, operationRoot = root;
        pending.add(record.message); paint(record, ids.length > 0);
        const current = () => !disposed && epoch === operationEpoch && root === operationRoot;
        void (async () => {
            try {
                await onToggle({message: record.message, element: record.element, source: source ? {...source} : null, ids});
            } catch (error) {
                if (current()) {
                    if (onError) onError(error);
                    else console.error('[Qianmu] Collection action failed', error);
                }
            } finally {
                // A late operation must not repaint another root/account.
                if (current()) { pending.delete(record.message); refresh(); }
            }
        })();
        return true;
    }

    function dispose() {
        if (disposed) return;
        disposed = true; clear(); root = null;
    }

    return {refresh, handleClick, dispose};
}
