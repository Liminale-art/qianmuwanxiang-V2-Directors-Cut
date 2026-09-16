const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** Existing theme descriptors are trusted application configuration, never model output. */
export function renderQianmuThemeMenu(themes, selected) {
    return `<div class="sd-theme-pick">
      <button type="button" class="sd-theme-btn" title="外观主题" aria-label="外观主题" aria-haspopup="menu" aria-expanded="false" aria-controls="qianmu-appearance-menu"><i class="fa-solid fa-palette"></i></button>
      <div id="qianmu-appearance-menu" class="sd-theme-menu" role="menu" aria-label="外观主题" hidden>
        ${themes.map(theme => `<button type="button" class="sd-theme-opt ${selected === theme.key ? 'active' : ''}" role="menuitemradio" aria-checked="${selected === theme.key}" data-theme="${escape(theme.key)}">
          <span class="sd-theme-dot" style="background:${escape(theme.dot)}"></span><span class="sd-theme-name">${escape(theme.name)}</span>
        </button>`).join('')}
      </div>
    </div>`;
}

/** Call the disposer before rerender, modal close, or extension cleanup. No settings ownership. */
export function bindQianmuThemeMenu(root, onSelect) {
    const pick = root.querySelector('.sd-theme-pick'), trigger = pick?.querySelector('.sd-theme-btn'), menu = pick?.querySelector('.sd-theme-menu');
    if (!pick || !trigger || !menu) return () => {};
    const document = root.ownerDocument, buttons = [...menu.querySelectorAll('.sd-theme-opt')];
    const keys = new Map(buttons.map(button => [button, button.dataset.theme]));
    let disposed = false, listening = false;
    function close(restoreFocus = false) {
        menu.hidden = true; pick.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false');
        if (listening) { document.removeEventListener('click', outside, true); listening = false; }
        if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
    }
    function outside(event) { if (!pick.contains(event.target)) close(); }
    function available() { return buttons.filter(button => !button.disabled && !button.hidden); }
    function open(last = false) {
        if (disposed) return;
        menu.hidden = false; pick.classList.add('open'); trigger.setAttribute('aria-expanded', 'true');
        if (!listening) { document.addEventListener('click', outside, true); listening = true; }
        const options = available(), selected = options.find(button => button.getAttribute('aria-checked') === 'true');
        (last ? options.at(-1) : selected || options[0])?.focus({ preventScroll: true });
    }
    function toggle(event) { event.stopPropagation(); if (menu.hidden) open(); else close(true); }
    function select(event) {
        const button = event.target.closest?.('.sd-theme-opt');
        if (disposed || menu.hidden || !keys.has(button) || button.disabled || button.hidden) return;
        const key = keys.get(button);
        if (!key || button.dataset.theme !== key) return;
        event.stopPropagation(); close(); onSelect(key);
    }
    function keydown(event) {
        if (disposed) return;
        if (menu.hidden) {
            if (event.target === trigger && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
                event.preventDefault(); event.stopPropagation(); open(event.key === 'ArrowUp');
            }
            return;
        }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
        if (event.key === 'Tab') { close(true); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const options = available(), index = options.indexOf(document.activeElement);
        if (!options.length) return;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next].focus({ preventScroll: true });
    }
    trigger.addEventListener('click', toggle); menu.addEventListener('click', select); pick.addEventListener('keydown', keydown);
    return () => {
        if (disposed) return; disposed = true; close();
        trigger.removeEventListener('click', toggle); menu.removeEventListener('click', select); pick.removeEventListener('keydown', keydown);
    };
}
