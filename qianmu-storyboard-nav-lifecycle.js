// Preserve only the optional glass navigation, never page content or renderer-owned state.
// Weak ownership avoids duplicate handlers when a nav survives a full modal render.
const routeListeners = new WeakMap();

export function bindQianmuStoryboardNavigation(root, onNavigate) {
    for (const button of root.querySelectorAll('[data-storyboard-view]')) {
        const previous = routeListeners.get(button);
        if (previous) button.removeEventListener('click', previous);
        const listener = () => { if (!button.disabled) onNavigate(button); };
        button.addEventListener('click', listener);
        routeListeners.set(button, listener);
    }
}

function items(nav) {
    return nav ? [...nav.querySelectorAll('button[data-storyboard-view]')] : [];
}

function captureFrame(buttons, view) {
    return buttons.flatMap(button => [button, button.querySelector('span')]).filter(Boolean).map(node => {
        const style = view.getComputedStyle(node);
        const names = node.tagName === 'BUTTON' ? ['width', 'background-color', 'color'] : ['width', 'margin-inline-start', 'opacity', 'transform'];
        return { node, values: names.map(name => [name, style.getPropertyValue(name)]) };
    });
}

function resumeFrame(nav, frame) {
    // Reparenting through innerHTML cancels native CSS transitions, even on reused nodes.
    // Establish the last painted (possibly mid-transition) frame, then release it back to
    // the authored CSS. This keeps reduced-motion rules and rapid reversal native.
    const saved = frame.map(({ node }) => node.getAttribute('style'));
    try {
        for (const { node, values } of frame) {
            node.style.setProperty('transition', 'none', 'important');
            for (const [name, value] of values) node.style.setProperty(name, value, 'important');
        }
        void nav.offsetWidth; // One layout flush per render transaction, never one per item.
    } finally {
        frame.forEach(({ node }, index) => {
            if (saved[index] === null) node.removeAttribute('style');
            else node.setAttribute('style', saved[index]);
        });
    }
}

/**
 * Call before the modal's innerHTML replacement, then invoke the returned callback
 * immediately after it and before icon/event binding. Classic rendering is unchanged.
 * Do not detach ahead of time: a failed body renderer leaves the old DOM untouched.
 */
export function preserveQianmuStoryboardNav(root, storyboardLayout) {
    if (!storyboardLayout || root.getAttribute('data-qm-theme') !== 'glass') return () => false;
    let oldNav = root.querySelector('.sd-storyboard-nav');
    if (!oldNav) return () => false;
    let frame = captureFrame(items(oldNav), root.ownerDocument.defaultView);
    let focused = oldNav.contains(root.ownerDocument.activeElement) ? root.ownerDocument.activeElement : null;
    return () => {
        // One render transaction only; never hold detached nav nodes after restoration.
        const previous = oldNav, painted = frame, focusTarget = focused; oldNav = null; frame = null; focused = null;
        if (!previous || !root.isConnected) return false;
        const next = root.querySelector('.sd-storyboard-nav');
        if (!next || next === previous) return false;
        const before = items(previous), after = items(next);
        const keys = before.map(button => button.dataset.storyboardView);
        if (!keys.length || new Set(keys).size !== keys.length || before.length !== after.length
            || before.some((button, i) => button.dataset.storyboardView !== after[i].dataset.storyboardView
                || button.getAttribute('aria-label') !== after[i].getAttribute('aria-label')
                || button.querySelector('span')?.textContent !== after[i].querySelector('span')?.textContent)) return false;
        next.replaceWith(previous);
        for (let i = 0; i < before.length; i++) {
            before[i].classList.toggle('active', after[i].classList.contains('active'));
            before[i].setAttribute('aria-current', after[i].getAttribute('aria-current') || 'false');
            before[i].disabled = after[i].disabled;
        }
        resumeFrame(previous, painted);
        // A clicked/keyboard-focused tab stays focused; do not steal a new editor's focus.
        if (focusTarget && root.ownerDocument.activeElement === root.ownerDocument.body) focusTarget.focus({ preventScroll: true });
        return true;
    };
}
