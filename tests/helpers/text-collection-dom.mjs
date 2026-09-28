// A scoped DOM/event double for behavior tests. No browser layout or ST proof.
// Textarea values deliberately normalize newlines as browsers do.
export function textCollectionDom() {
    const doc = {activeElement: null, visibilityState: 'visible'};
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase();
            this.ownerDocument = doc;
            this.children = []; this.attrs = {}; this.dataset = {}; this.style = {};
            this.listeners = new Map(); this.parentNode = null;
            this._text = ''; this._value = ''; this._markup = '';
            this.disabled = false; this.hidden = false; this.open = false;
            this.checked = false; this.scrollTop = 0; this.className = '';
            this.selectionStart = 0; this.selectionEnd = 0;
            this.classList = {
                contains: name => this.className.split(/\s+/).includes(name),
                add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
                remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
                toggle: (name, force) => {
                    const enabled = force ?? !this.classList.contains(name);
                    this.classList[enabled ? 'add' : 'remove'](name); return enabled;
                },
            };
        }
        get isConnected() { return this === doc.documentElement || this.parentNode?.isConnected === true; }
        get parentElement() { return this.parentNode; }
        set type(value) { this.attrs.type = String(value); }
        get type() { return this.attrs.type || ''; }
        get childNodes() { return this.children; }
        get firstChild() { return this.children[0] ?? null; }
        get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; }
        set textContent(value) {
            this._text = String(value); for (const child of this.children) child.parentNode = null; this.children = [];
        }
        get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
        set innerHTML(value) {
            if (this.tagName !== 'SVG') throw Error('Collection test prohibits HTML rendering outside static SVG icons');
            this._markup = String(value);
        }
        get innerHTML() { return this._markup; }
        set value(value) { this._value = this.tagName === 'TEXTAREA' ? String(value).replace(/\r\n?/g, '\n') : String(value); }
        get value() { return this._value; }
        append(...nodes) {
            for (let node of nodes) {
                if (!(node instanceof Element)) { const text = new Element('#text'); text.textContent = String(node); node = text; }
                node.remove(); node.parentNode = this; this.children.push(node);
            }
        }
        appendChild(node) { this.append(node); return node; }
        insertBefore(node, reference) {
            if (reference === null) return this.appendChild(node);
            if (reference.parentNode !== this) throw Error('Reference is not a child');
            if (node === reference) return node;
            node.remove(); node.parentNode = this; this.children.splice(this.children.indexOf(reference), 0, node); return node;
        }
        replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
        remove() {
            if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
            this.parentNode = null;
        }
        contains(node) { return node === this || this.children.some(child => child.contains(node)); }
        setAttribute(name, value) {
            this.attrs[name] = String(value);
            if (name === 'class') this.className = String(value);
        }
        getAttribute(name) { return this.attrs[name] ?? null; }
        hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
        removeAttribute(name) { delete this.attrs[name]; }
        addEventListener(name, handler, options) {
            if (!this.listeners.has(name)) this.listeners.set(name, new Set());
            this.listeners.get(name).add({handler, once: options?.once === true});
        }
        removeEventListener(name, handler) {
            for (const entry of this.listeners.get(name) || []) if (entry.handler === handler) this.listeners.get(name).delete(entry);
        }
        emit(name, extra = {}) {
            let stopped = false;
            const event = {
                type: name, target: this, currentTarget: this, bubbles: !['close', 'cancel'].includes(name), defaultPrevented: false,
                preventDefault() { this.defaultPrevented = true; },
                stopPropagation() { stopped = true; },
                ...extra,
            };
            for (let node = this; node; node = node.parentNode) {
                event.currentTarget = node;
                for (const entry of [...(node.listeners.get(name) || [])]) {
                    if (entry.once) node.listeners.get(name).delete(entry);
                    entry.handler(event);
                }
                if (stopped || !event.bubbles) break;
            }
            return event;
        }
        focus() { doc.activeElement = this; }
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
        click() {
            if (this.disabled) return;
            if (this.tagName === 'INPUT' && this.type === 'checkbox') {
                this.checked = !this.checked; this.emit('click'); this.emit('input'); this.emit('change');
            } else this.emit('click');
        }
        showModal() { if (!this.isConnected) throw Error('Detached dialog'); this.open = true; }
        // HTML dialog close updates open immediately but queues its close event.
        close() { if (this.open) { this.open = false; setImmediate(() => this.emit('close')); } }
        matches(selector) {
            const parts = selector.match(/^([a-z]+)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/i);
            if (!parts) throw Error(`Unsupported selector in collection DOM double: ${selector}`);
            return (!parts[1] || this.tagName === parts[1].toUpperCase())
                && (!parts[2] || this.classList.contains(parts[2]))
                && (!parts[3] || this.hasAttribute(parts[3]) && (parts[4] === undefined || this.getAttribute(parts[3]) === parts[4]));
        }
        querySelectorAll(selector) { return all(this).filter(node => node.matches(selector)); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
    }
    const all = (root = doc.body) => root.children.flatMap(node => [node, ...all(node)]);
    doc.createElement = tag => new Element(tag);
    doc.createElementNS = (_namespace, tag) => new Element(tag);
    doc.documentElement = new Element('html'); doc.head = new Element('head'); doc.body = new Element('body');
    doc.documentElement.append(doc.head, doc.body);
    doc.querySelector = selector => doc.documentElement.querySelector(selector);
    doc.querySelectorAll = selector => doc.documentElement.querySelectorAll(selector);
    doc.defaultView = {AbortController, navigator: {clipboard: {writeText() { throw Error('Inject explicit clipboard fixture'); }}}};
    const parent = new Element('section'); doc.body.append(parent);
    return {
        doc, parent, all,
        get: label => all().find(node => node.getAttribute('aria-label') === label),
        byClass: name => all().find(node => node.classList.contains(name)),
        status: () => all().find(node => node.getAttribute('role') === 'status'),
        visible: node => !!node && node.isConnected && !node.hidden && (!node.parentNode || node.parentNode === doc.documentElement || !allAncestors(node).some(parent => parent.hidden)),
        async wait(predicate, description = 'collection DOM did not settle') {
            for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
            throw Error(description);
        },
    };
    function allAncestors(node) { const parents = []; for (let parent = node.parentNode; parent; parent = parent.parentNode) parents.push(parent); return parents; }
}
