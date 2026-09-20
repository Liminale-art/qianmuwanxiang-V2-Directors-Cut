const mounted = new WeakMap();
const KEY_EVENTS = ['keydown', 'keyup', 'keypress'];
const EDITOR_EVENTS = ['beforeinput', 'input', 'change', 'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'copy', 'cut', 'focusin', 'focusout', 'pointerdown', 'mousedown', 'touchstart', 'click'];

function isEditorTarget(event, root) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (!path.length) {
        for (let node = event.target; node; node = node.parentNode) { path.push(node); if (node === root) break; }
    }
    for (const node of path) {
        if (node?.nodeType === 1 && (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) || node.isContentEditable)) return true;
        if (node === root) break;
    }
    return false;
}

/**
 * Isolate app-owned controls from host document-level bubbling hotkeys/focus helpers.
 * Defaults, IME, clipboard operations and other listeners on this root stay intact.
 * Host/third-party capture listeners have already run and are deliberately untouched.
 */
export function mountQianmuInputBoundary(root) {
    if (!root || typeof root.addEventListener !== 'function' || typeof root.removeEventListener !== 'function') return () => {};
    const prior = mounted.get(root);
    if (prior) return prior;
    const keyboard = event => event.stopPropagation();
    const editor = event => { if (isEditorTarget(event, root)) event.stopPropagation(); };
    for (const type of KEY_EVENTS) root.addEventListener(type, keyboard);
    for (const type of EDITOR_EVENTS) root.addEventListener(type, editor);
    let active = true;
    const off = () => {
        if (!active) return;
        active = false;
        for (const type of KEY_EVENTS) root.removeEventListener(type, keyboard);
        for (const type of EDITOR_EVENTS) root.removeEventListener(type, editor);
        if (mounted.get(root) === off) mounted.delete(root);
    };
    mounted.set(root, off);
    return off;
}
