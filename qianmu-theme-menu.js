import { readAppearancePreferences } from './qianmu-appearance-settings.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const accents = Object.freeze([['#5c79d3', '鸢蓝'], ['#7b65a7', '烟紫'], ['#527c69', '松绿'], ['#ad7950', '赭金'], ['#b86773', '蔷薇'], ['#8b584a', '陶棕']]);
const modeIcon = mode => mode === 'dark'
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14a8 8 0 0 1-10-10A8.5 8.5 0 1 0 20 14Z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/></svg>';

/** Existing theme descriptors are trusted application configuration, never model output. */
export function renderQianmuThemeMenu(themes, selected, { settings, supported = false } = {}) {
    const preference = readAppearancePreferences(settings);
    const current = !supported || preference.family === 'classic' ? selected : '';
    const classic = themes.map(theme => `<button type="button" class="sd-theme-opt ${current === theme.key ? 'active' : ''}${supported && ['light', 'dark'].includes(theme.key) ? ' sd-theme-classic-mode' : ''}" role="menuitemradio" aria-checked="${current === theme.key}" data-theme="${escape(theme.key)}" aria-label="${escape(theme.name)}" title="${escape(theme.name)}">
          ${supported && ['light', 'dark'].includes(theme.key) ? modeIcon(theme.key) : `<span class="sd-theme-dot" style="background:${escape(theme.dot)}"></span><span class="sd-theme-name">${escape(theme.name)}</span>`}
        </button>`).join('');
    const families = ['editorial', 'glass', 'classic'].map((family, index) => `<button type="button" class="sd-theme-opt ${preference.family === family ? 'active' : ''}" role="menuitemradio" aria-checked="${preference.family === family}" data-appearance-family="${family}" aria-controls="qianmu-theme-details"><span class="sd-theme-dot sd-theme-dot-${family}" aria-hidden="true"></span><span class="sd-theme-name">${['纸间', '流光', '经典'][index]}</span></button>`).join('');
    const swatches = accents.map(([accent, name]) => `<button type="button" class="sd-theme-opt sd-theme-swatch" role="menuitemradio" aria-checked="${preference.accent === accent}" data-appearance-accent="${accent}" title="${name}" aria-label="${name}" style="--sd-swatch:${accent}"><span aria-hidden="true"></span></button>`).join('');
    return `<div class="sd-theme-pick">
      <button type="button" class="sd-theme-btn" title="外观主题" aria-label="外观主题" aria-haspopup="menu" aria-expanded="false" aria-controls="qianmu-appearance-menu"><i class="fa-solid fa-palette"></i></button>
      <div id="qianmu-appearance-menu" class="sd-theme-menu${supported ? ' is-appearance' : ''}" role="menu" aria-label="外观主题" hidden>
        ${supported ? `<div class="sd-theme-family-options" role="group" aria-label="主题">${families}</div>
        <div id="qianmu-theme-details" class="sd-theme-details" role="group" aria-label="主题颜色">
          <div class="sd-theme-classic-options" role="group" aria-label="经典颜色"${preference.family === 'classic' ? '' : ' hidden'}>${classic}</div>
          <div class="sd-theme-accent-options" role="group" aria-label="强调色"${preference.family === 'classic' ? ' hidden' : ''}>
            <div class="sd-theme-detail-head"><span>强调色</span><button type="button" class="sd-theme-opt sd-theme-mode-toggle" role="menuitem" data-appearance-mode-toggle aria-label="切换至${preference.mode === 'dark' ? '日间' : '夜间'}" title="切换至${preference.mode === 'dark' ? '日间' : '夜间'}">${modeIcon(preference.mode)}</button></div>
            <div class="sd-theme-swatches">${swatches}<label class="sd-theme-custom-color sd-theme-swatch${accents.some(([accent]) => accent === preference.accent) ? '' : ' active'}" title="自定强调色" style="--sd-swatch:${preference.accent}"><span aria-hidden="true">+</span><input class="sd-theme-color" type="color" value="${preference.accent}" aria-label="自定强调色"></label></div>
          </div>
        </div><div class="sd-theme-feedback" hidden><span class="sd-theme-status" role="status" aria-live="polite"></span><button type="button" class="sd-theme-opt sd-theme-retry" role="menuitem" hidden>重试</button></div>` : classic}
      </div>
    </div>`;
}

/** Call the disposer before rerender, modal close, or extension cleanup. No settings ownership. */
export function bindQianmuThemeMenu(root, onSelect, appearance = null) {
    const pick = root.querySelector('.sd-theme-pick'), trigger = pick?.querySelector('.sd-theme-btn'), menu = pick?.querySelector('.sd-theme-menu');
    if (!pick || !trigger || !menu) return () => {};
    const document = root.ownerDocument, buttons = [...menu.querySelectorAll('.sd-theme-opt')];
    const keys = new Map(buttons.map(button => [button, { classic: button.dataset.theme, family: button.dataset.appearanceFamily, accent: button.dataset.appearanceAccent }]));
    const classicOptions = menu.querySelector?.('.sd-theme-classic-options'), accentOptions = menu.querySelector?.('.sd-theme-accent-options');
    const color = menu.querySelector?.('.sd-theme-color'), customColor = menu.querySelector?.('.sd-theme-custom-color'), mode = menu.querySelector?.('.sd-theme-mode-toggle');
    const feedback = menu.querySelector?.('.sd-theme-feedback'), status = menu.querySelector?.('.sd-theme-status'), retry = menu.querySelector?.('.sd-theme-retry');
    let disposed = false, listening = false, actionError = '', sequence = 0;
    function refresh() {
        if (disposed || !appearance) return;
        const preference = appearance.read(), resource = appearance.status();
        const retryHadFocus = retry && document.activeElement === retry;
        for (const button of buttons) {
            const key = keys.get(button);
            if (!key.classic && !key.family && !key.accent) continue;
            const checked = key.classic ? preference.family === 'classic' && key.classic === preference.classic
                : key.family ? key.family === preference.family : key.accent === preference.accent;
            button.setAttribute('aria-checked', String(checked)); button.classList[checked ? 'add' : 'remove']('active');
        }
        if (classicOptions) classicOptions.hidden = preference.family !== 'classic';
        if (accentOptions) accentOptions.hidden = preference.family === 'classic';
        if (color && color.value !== preference.accent) color.value = preference.accent;
        if (customColor) {
            customColor.style.setProperty('--sd-swatch', preference.accent);
            customColor.classList[accents.some(([accent]) => accent === preference.accent) ? 'remove' : 'add']('active');
        }
        if (mode) {
            const title = `切换至${preference.mode === 'dark' ? '日间' : '夜间'}`;
            mode.setAttribute('aria-label', title); mode.setAttribute('title', title);
            if (mode.dataset.currentMode !== preference.mode) { mode.innerHTML = modeIcon(preference.mode); mode.dataset.currentMode = preference.mode; }
        }
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
    const visible = node => node && !node.disabled && !node.hidden && !node.closest?.('[hidden]');
    function available() { return [...buttons, ...(color ? [color] : [])].filter(visible); }
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
        if (disposed || menu.hidden || !keys.has(button) || !visible(button)) return;
        const key = keys.get(button);
        if (button === retry && appearance) {
            event.stopPropagation(); actionError = ''; sequence++;
            try { const result = appearance.retry(); refresh(); settle(result); }
            catch { actionError = '外观资源重试失败，请稍后再试。'; refresh(); }
            return;
        }
        if (key.family || key.accent || button === mode) {
            if (!appearance || button.dataset.appearanceFamily !== key.family || button.dataset.appearanceAccent !== key.accent) return;
            event.stopPropagation(); actionError = ''; sequence++;
            try {
                const result = key.family === 'classic' ? onSelect(appearance.read().classic)
                    : appearance.change(key.family ? { family: key.family } : key.accent ? { accent: key.accent, source: 'manual' } : { mode: appearance.read().mode === 'dark' ? 'light' : 'dark' });
                refresh(); settle(result);
            }
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
    function chooseColor(event) {
        if (disposed || menu.hidden || event.target !== color || !visible(color) || !appearance || appearance.read().family === 'classic' || !/^#[a-f\d]{6}$/i.test(color.value)) return;
        // A failed native input is rolled back by refresh. Its trailing change
        // must not clear the failure by "successfully" applying the old color.
        if (event.type === 'change' && actionError && color.value === appearance.read().accent) return;
        actionError = ''; sequence++;
        try { const result = appearance.change({ accent: color.value, source: 'manual' }); refresh(); settle(result); }
        catch { actionError = '颜色切换未完成，已保留原设置。'; refresh(); }
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
        if (event.target === color) return; // Native color picker owns its arrow keys.
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const options = available(), index = options.indexOf(document.activeElement);
        if (!options.length) return;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next].focus({ preventScroll: true });
    }
    trigger.addEventListener('click', toggle); menu.addEventListener('click', select); pick.addEventListener('keydown', keydown);
    color?.addEventListener('input', chooseColor); color?.addEventListener('change', chooseColor);
    if (appearance) { refresh(); settle(appearance.sync()); }
    return () => {
        if (disposed) return; disposed = true; sequence++; close();
        trigger.removeEventListener('click', toggle); menu.removeEventListener('click', select); pick.removeEventListener('keydown', keydown);
        color?.removeEventListener('input', chooseColor); color?.removeEventListener('change', chooseColor);
    };
}
