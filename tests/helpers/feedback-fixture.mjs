// In-memory DOM/event double only; not a browser or real ST layout claim.
export function feedbackFixture({ userAgent = 'Windows Firefox/120', copy = async () => {} } = {}) {
    const copied = [], downloaded = [];
    class Element {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = new Map(); this.value = ''; this.disabled = false; this.isConnected = true; this.open = false; this.className = ''; this._text = ''; this.ownerDocument = doc; this.classList = { contains: name => this.className.split(' ').includes(name) }; }
        set textContent(value) { this._text = value; this.children = []; }
        get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
        append(...nodes) { this.children.push(...nodes); }
        replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
        setAttribute(key, value) { this.attrs[key] = value; }
        focus() { doc.activeElement = this; }
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
        addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
        removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
        async emit(type, extra = {}) { for (const fn of this.listeners.get(type) || []) await fn({ target: this, preventDefault() { this.defaultPrevented = true; }, ...extra }); }
        querySelector(selector) { return find(this, node => node.className.split(' ').includes(selector.slice(1))); }
    }
    const doc = { defaultView: { navigator: { userAgent, clipboard: { async writeText(text) { copied.push(text); return copy(text); } } } } };
    doc.createElement = tag => new Element(tag);
    const host = new Element('div');
    const find = (root, predicate) => { for (const child of root.children) { if (predicate(child)) return child; const nested = find(child, predicate); if (nested) return nested; } return null; };
    const all = (root = host) => root.children.flatMap(node => [node, ...all(node)]);
    return { doc, host, copied, downloaded, create: tag => doc.createElement(tag), all,
        get: label => find(host, node => node.attrs['aria-label'] === label),
        button: label => find(host, node => node.tagName === 'BUTTON' && node.textContent === label),
        status: () => find(host, node => node.attrs.role === 'status'),
        download: (blob, name) => downloaded.push({ blob, name }) };
}
export const settleFeedback = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
