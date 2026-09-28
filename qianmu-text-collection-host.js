import {createTextCollectionOwner} from './qianmu-text-collection-owner.js';
import {createTextCollectionFloor} from './qianmu-text-collection-floor.js';
import {textCollectionFloorSources, collectionSourceKey} from './qianmu-text-collection-source.js';
import {floorProseText} from './qianmu-prose-floor-entries.js';

// This is the entire ST seam: existing host events call refresh/handleClick.
// No mutation observer, settings save, message mutation or render replacement.
export function createTextCollectionHost(options) {
    const window = options.window || options.document?.defaultView || globalThis.window;
    let root = null, owner = null, floor = null, chat = null, metadata = null, location = null, disposed = false, warmed = false;
    const live = () => !disposed && options.isCurrent() === true;
    function typography(parent) {
        if (!parent) return;
        const doc = parent.ownerDocument, prose = root?.querySelector('.sd-prose-run') || root?.querySelector('.mes_text');
        const style = doc.defaultView.getComputedStyle(prose || doc.body);
        const layout = doc.body.classList.contains('sd-prose-layout');
        const set = (key, value) => { if (value) parent.style.setProperty(key, value); else parent.style.removeProperty(key); };
        set('--qm-prose-font', style.fontFamily);
        set('--qm-prose-size', layout && style.getPropertyValue('--sd-prose-font-size') || style.fontSize);
        set('--qm-prose-line-height', layout && style.getPropertyValue('--sd-prose-line-height') || style.lineHeight);
        const paragraph = prose?.querySelector('p');
        set('--qm-prose-paragraph-gap', layout && style.getPropertyValue('--sd-prose-paragraph-gap')
            || paragraph && doc.defaultView.getComputedStyle(paragraph).marginBottom || '1em');
    }
    function ensure() {
        if (!live()) return null;
        if (owner?.disposed) { floor?.dispose(); floor = null; owner = null; warmed = false; }
        if (owner) return owner;
        owner = createTextCollectionOwner({...options, typography, onChange: () => { if (live()) floor?.refresh(root); }});
        floor = createTextCollectionFloor({getContext: options.getContext, getSourceMap: textCollectionFloorSources,
            getItems: () => owner?.floorItems() || [], applyIcons: options.applyIcons,
            onError: () => options.notify?.('收藏未能完成，请重试。', 'warning'),
            onToggle: ({message, element, source, ids}) => {
                const context = options.getContext(), messages = context.chat, text = message.mes, swipe = message.swipe_id;
                const input = {text: floorProseText(element.querySelector('.mes_text')), ...options.names(), source};
                const valid = () => live() && options.getContext().chat === messages && messages.includes(message)
                    && message.mes === text && message.swipe_id === swipe && root?.contains(element)
                    && collectionSourceKey(textCollectionFloorSources(options.getContext()).get(message)) === collectionSourceKey(source);
                return owner.toggle(input, valid, ids.length ? 'remove' : 'collect');
            },
        });
        return owner;
    }
    function refresh(nextRoot) {
        if (!live()) return;
        root = nextRoot;
        const current = ensure(), context = options.getContext();
        const nextLocation = JSON.stringify([context.chatId, context.characterId, context.groupId]);
        if (chat !== context.chat || metadata !== context.chatMetadata || location !== nextLocation) {
            current.chatChanged(); chat = context.chat; metadata = context.chatMetadata; location = nextLocation;
        }
        floor.refresh(root);
        if (!warmed && root?.querySelector('.mes')) { warmed = true; void current.warm(); }
    }
    function dispose() {
        if (disposed) return;
        disposed = true; floor?.dispose(); owner?.dispose(); root = null; floor = null; owner = null;
        window?.removeEventListener?.('pageshow', shown);
    }
    function shown() { if (root && live()) refresh(root); }
    window?.addEventListener?.('pageshow', shown);
    return Object.freeze({refresh, handleClick: event => live() && !!floor?.handleClick(event),
        open: () => ensure()?.open() ?? Promise.resolve(false), dispose});
}
