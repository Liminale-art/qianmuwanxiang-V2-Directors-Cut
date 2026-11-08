import {textCollectionDom} from './text-collection-dom.mjs';

// Reuse the existing behavioral DOM, adding only the assistant window's needs.
// This is not a browser layout, viewport or real ST acceptance fixture.
export function proseAssistantPanelDom() {
    const dom = textCollectionDom(), prototype = Object.getPrototypeOf(dom.parent);
    const attribute = prototype.getAttribute, matches = prototype.matches;
    const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    prototype.getAttribute = function (name) {
        return name.startsWith('data-') && Object.hasOwn(this.dataset, dataKey(name))
            ? String(this.dataset[dataKey(name)]) : attribute.call(this, name);
    };
    prototype.hasAttribute = function (name) { return this.getAttribute(name) !== null; };
    prototype.matches = function (selector) {
        return selector.split(',').some(part => matches.call(this, part.trim()));
    };
    // The window controller paints geometry through style.setProperty(..., 'important').
    const styled = element => {
        const style = element.style;
        // Non-enumerable but writable, so individual tests may still override them.
        const method = value => ({value, writable: true, configurable: true});
        if (typeof style.setProperty !== 'function') Object.defineProperties(style, {
            setProperty: method((name, value) => { style[name] = String(value); }),
            removeProperty: method(name => { const old = style[name] ?? ''; delete style[name]; return old; }),
            getPropertyValue: method(name => style[name] ?? ''),
        });
        return element;
    };
    const create = dom.doc.createElement, createNS = dom.doc.createElementNS;
    dom.doc.createElement = tag => styled(create(tag));
    dom.doc.createElementNS = (namespace, tag) => styled(createNS(namespace, tag));
    styled(dom.parent);
    const events = new EventTarget(), preferences = new Map(), observers = new Set();
    Object.assign(dom.doc.defaultView, {
        innerWidth: 800, innerHeight: 900, setTimeout, clearTimeout,
        addEventListener: (...args) => events.addEventListener(...args),
        removeEventListener: (...args) => events.removeEventListener(...args),
        localStorage: {getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, String(value))},
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe() { observers.add(this); }
            disconnect() { observers.delete(this); }
        },
    });
    return {...dom, observers};
}
