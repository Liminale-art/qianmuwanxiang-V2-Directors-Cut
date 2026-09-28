import {createTextCollectionPanel, TEXT_COLLECTION_STYLESHEET} from './qianmu-text-collection-panel.js';
import {createTextCollectionCapture, TEXT_COLLECTION_CAPTURE_STYLESHEET} from './qianmu-text-collection-capture.js';

// Created once by the account owner, not on every panel open. Only these two
// local stylesheets and this portal belong to the view.
export async function createTextCollectionView({document, collection, isCurrent, signal, mountPortal, typography}) {
    const parent = document.createElement('section'), links = [], loading = new AbortController();
    parent.className = 'qm-collection-portal';
    let panel, capture, detach, disposed = false;
    function dispose() {
        if (disposed) return;
        disposed = true; loading.abort(); signal?.removeEventListener('abort', dispose);
        capture?.dispose(); panel?.dispose(); detach?.(); parent.remove();
        for (const link of links) link.remove();
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
        panel = createTextCollectionPanel({parent, collection, isCurrent});
        capture = createTextCollectionCapture({parent, isCurrent, onSelect: (input, selection) => panel.collect(input, selection)});
        return Object.freeze({parent, panel, capture, dispose});
    } catch (error) { dispose(); throw error; }
}
