import {createTextCollectionPanel, TEXT_COLLECTION_STYLESHEET} from './qianmu-text-collection-panel.js?v=1.59.419';
import {createTextCollectionCapture, textCollectionCaptureEntries, TEXT_COLLECTION_CAPTURE_STYLESHEET} from './qianmu-text-collection-capture.js?v=1.59.419';
import {loadLocalChunk} from './qianmu-feature-runtime.js?v=1.59.425';

// 收藏条目 → 书摘成图的输入：原文、楼层号（只在当前聊天里对得上）、那一层第一次生成的时刻（来源标识里记着）。
export function excerptInputOf(item, locate) {
    let floor = null, sentAt = '';
    try { const found = locate?.(item.source); floor = Number.isInteger(found) ? found : null; } catch { floor = null; }
    try { const parsed = JSON.parse(item.source?.messageId || 'null'); sentAt = Array.isArray(parsed) && typeof parsed[1] === 'string' ? parsed[1] : ''; } catch { sentAt = ''; }
    return {key: item.id, stamp: item.updatedAt || '', body: item.text,
        source: {charName: item.charName, userName: item.userName, floor, sentAt, createdAt: item.createdAt}};
}

// Created once by the account owner, not on every panel open. Only these two
// local stylesheets and this portal belong to the view.
export async function createTextCollectionView({document, collection, isCurrent, signal, mountPortal, typography, verifyAccount, download, locateFloor, jumpToFloor, excerpt, namespace, notify = () => {}, collectionEnabled, collectionTagRules, formatRaw}) {
    const parent = document.createElement('section'), links = [], loading = new AbortController();
    parent.className = 'qm-collection-portal';
    let panel, capture, studio = null, studioModule = null, detach, disposed = false;
    function dispose() {
        if (disposed) return;
        disposed = true; loading.abort(); signal?.removeEventListener('abort', dispose);
        studio?.dispose(); capture?.dispose(); panel?.dispose(); detach?.(); parent.remove();
        for (const link of links) link.remove();
    }
    // 书摘成图页较大，第一次点「存图」时才载入。
    async function openStudio(item) {
        if (disposed || !isCurrent()) return;
        try {
            studioModule ??= loadLocalChunk('./qianmu-excerpt-studio.js');
            const module = await studioModule;
            if (disposed || !isCurrent()) return;
            studio ??= module.createExcerptStudio({parent, settings: excerpt, fonts: excerpt?.fonts, download, verifyAccount, isCurrent, namespace});
            const input = excerptInputOf(item, (() => { try { return locateFloor?.(); } catch { return null; } })());
            await studio.open({key: input.key, stamp: input.stamp, body: input.body, fields: module.excerptFields(input.source)});
        } catch (error) {
            studioModule = null;
            console.warn('[千幕] 书摘成图打开失败', error);
            if (!disposed) notify('书摘成图没能打开，请重试。', 'warning');
        }
    }
    signal?.addEventListener('abort', dispose, {once: true});
    try {
        if (signal?.aborted || !isCurrent()) throw Error('Collection view is no longer current');
        await Promise.all([TEXT_COLLECTION_STYLESHEET, TEXT_COLLECTION_CAPTURE_STYLESHEET].map(url => new Promise((resolve, reject) => {
            const link = document.createElement('link'); links.push(link);
            link.rel = 'stylesheet'; link.href = url.href;
            const timeout = setTimeout(() => finish(Error('收藏样式加载超时，请重试。')), 15000);
            const finish = error => {
                clearTimeout(timeout);
                link.removeEventListener('load', loaded); link.removeEventListener('error', failed);
                loading.signal.removeEventListener('abort', aborted);
                if (error) reject(error); else resolve();
            };
            const loaded = () => finish(), failed = () => finish(Error('收藏样式加载失败，请重试。'));
            const aborted = () => finish(Error('Collection view closed'));
            link.addEventListener('load', loaded, {once: true}); link.addEventListener('error', failed, {once: true});
            loading.signal.addEventListener('abort', aborted, {once: true}); document.head.append(link);
        })));
        if (disposed || !isCurrent()) throw Error('Collection view is no longer current');
        document.body.append(parent); detach = mountPortal?.(parent); typography?.(parent);
        panel = createTextCollectionPanel({parent, collection, isCurrent, onExportImage: item => { void openStudio(item); }, locateFloor, onJumpFloor: jumpToFloor,
            enabled: collectionEnabled, tagRules: collectionTagRules, formatRaw});
        capture = createTextCollectionCapture({parent, isCurrent, onSelect: (input, selection) => panel.collect(input, selection),
            ...textCollectionCaptureEntries(collection)});
        return Object.freeze({parent, panel, capture, dispose});
    } catch (error) { dispose(); throw error; }
}
