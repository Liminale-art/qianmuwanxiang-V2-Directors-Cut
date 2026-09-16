import { readAppearancePreferences } from './qianmu-appearance-settings.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** Existing theme descriptors are trusted application configuration, never model output. */
export function renderQianmuThemeMenu(themes, selected, { settings, supported = false } = {}) {
    const preference = readAppearancePreferences(settings);
    const current = !supported || preference.family === 'classic' ? selected : '';
    const classic = themes.map(theme => `<button type="button" class="sd-theme-opt ${current === theme.key ? 'active' : ''}" role="menuitemradio" aria-checked="${current === theme.key}" data-theme="${escape(theme.key)}">
          <span class="sd-theme-dot" style="background:${escape(theme.dot)}"></span><span class="sd-theme-name">${escape(theme.name)}</span>
        </button>`).join('');
    const families = ['editorial', 'glass'].map((family, index) => `<button type="button" class="sd-theme-opt ${preference.family === family ? 'active' : ''}" role="menuitemradio" aria-checked="${preference.family === family}" data-appearance-family="${family}"><span class="sd-theme-dot sd-theme-dot-${family}" aria-hidden="true"></span><span class="sd-theme-name">${['纸间', '流光'][index]}</span></button>`).join('');
    const modes = ['light', 'dark'].map((mode, index) => `<button type="button" class="sd-theme-opt sd-appearance-mode" role="menuitemradio" aria-checked="${preference.mode === mode}" data-appearance-mode="${mode}">${['日间', '夜间'][index]}</button>`).join('');
    return `<div class="sd-theme-pick">
      <button type="button" class="sd-theme-btn" title="外观主题" aria-label="外观主题" aria-haspopup="menu" aria-expanded="false" aria-controls="qianmu-appearance-menu"><i class="fa-solid fa-palette"></i></button>
      <div id="qianmu-appearance-menu" class="sd-theme-menu${supported ? ' is-appearance' : ''}" role="menu" aria-label="外观主题" hidden>
        ${supported ? `<div class="sd-theme-family-options" role="group" aria-label="主题">${families}<span class="sd-theme-section" role="presentation">经典</span>${classic}</div><div class="sd-theme-modes" role="group" aria-label="明暗" ${preference.family === 'classic' ? 'hidden' : ''}>${modes}</div><div class="sd-theme-feedback" hidden><span class="sd-theme-status" role="status" aria-live="polite"></span><button type="button" class="sd-theme-opt sd-theme-retry" role="menuitem" hidden>重试</button></div>` : classic}
      </div>
    </div>`;
}

/** Call the disposer before rerender, modal close, or extension cleanup. No settings ownership. */
export function bindQianmuThemeMenu(root, onSelect, appearance = null) {
    const pick = root.querySelector('.sd-theme-pick'), trigger = pick?.querySelector('.sd-theme-btn'), menu = pick?.querySelector('.sd-theme-menu');
    if (!pick || !trigger || !menu) return () => {};
    const document = root.ownerDocument, buttons = [...menu.querySelectorAll('.sd-theme-opt')];
    const keys = new Map(buttons.map(button => [button, { classic: button.dataset.theme, family: button.dataset.appearanceFamily, mode: button.dataset.appearanceMode }]));
    const modes = menu.querySelector?.('.sd-theme-modes'), feedback = menu.querySelector?.('.sd-theme-feedback'), status = menu.querySelector?.('.sd-theme-status'), retry = menu.querySelector?.('.sd-theme-retry');
    let disposed = false, listening = false, actionError = '', sequence = 0;
    function refresh() {
        if (disposed || !appearance) return;
        const preference = appearance.read(), resource = appearance.status();
        const retryHadFocus = retry && document.activeElement === retry;
        for (const button of buttons) {
            const key = keys.get(button);
            if (!key.classic && !key.family && !key.mode) continue;
            const checked = key.classic ? preference.family === 'classic' && key.classic === preference.classic
                : key.family ? key.family === preference.family : key.mode === preference.mode;
            button.setAttribute('aria-checked', String(checked)); button.classList[checked ? 'add' : 'remove']('active');
            if (key.mode) button.hidden = preference.family === 'classic';
        }
        if (modes) modes.hidden = preference.family === 'classic';
        const failed = preference.family !== 'classic' && resource === 'error';
        const message = actionError || (failed ? '外观资源未加载，暂用经典外观。' : preference.family !== 'classic' && ['idle', 'loading'].includes(resource) ? '正在载入外观…' : '');
        if (status) status.textContent = message;
        if (feedback) feedback.hidden = !message;
        if (retry) retry.hidden = !failed;
        if (retry?.hidden && retryHadFocus && !menu.hidden) {
            buttons.find(button => keys.get(button).family === preference.family)?.focus({ preventScroll: true });
        }
        trigger.setAttribute('title', message ? `外观主题 · ${message}` : '外观主题');
        trigger.setAttribute('aria-label', message ? `外观主题：${message}` : '外观主题');
        trigger.classList[failed || actionError ? 'add' : 'remove']('has-appearance-error');
    }
    function settle(result, request = sequence) {
        Promise.resolve(result).then(() => { if (request === sequence) refresh(); }, () => {
            if (disposed || request !== sequence) return;
            actionError = '外观切换未完成，请重试或选择经典外观。'; refresh();
        });
    }
    function close(restoreFocus = false) {
        menu.hidden = true; pick.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false');
        if (listening) { document.removeEventListener('click', outside, true); listening = false; }
        if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
    }
    function outside(event) { if (!pick.contains(event.target)) close(); }
    function available() { return buttons.filter(button => !button.disabled && !button.hidden); }
    function open(last = false) {
        if (disposed) return;
        refresh();
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
        if (button === retry && appearance) {
            event.stopPropagation(); actionError = ''; sequence++;
            try { const result = appearance.retry(); refresh(); settle(result); }
            catch { actionError = '外观资源重试失败，请稍后再试。'; refresh(); }
            return;
        }
        if (key.family || key.mode) {
            if (!appearance || button.dataset.appearanceFamily !== key.family || button.dataset.appearanceMode !== key.mode) return;
            event.stopPropagation(); actionError = ''; sequence++;
            try { const result = appearance.change(key.family ? { family: key.family } : { mode: key.mode }); refresh(); settle(result); }
            catch { actionError = '外观切换未完成，已保留原设置。'; refresh(); }
            return;
        }
        if (!key.classic || button.dataset.theme !== key.classic) return;
        event.stopPropagation(); close(true);
        if (onSelect(key.classic) === false) return;
        actionError = ''; sequence++;
        if (appearance) { refresh(); return; }
        for (const option of buttons) {
            option.classList[option === button ? 'add' : 'remove']('active');
            option.setAttribute('aria-checked', String(option === button));
        }
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
    if (appearance) { refresh(); settle(appearance.sync()); }
    return () => {
        if (disposed) return; disposed = true; sequence++; close();
        trigger.removeEventListener('click', toggle); menu.removeEventListener('click', select); pick.removeEventListener('keydown', keydown);
    };
}
