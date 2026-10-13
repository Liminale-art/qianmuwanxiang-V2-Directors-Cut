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
    const classic = themes.map(theme => `<button type="button" class="sd-theme-opt ${current === theme.key ? 'active' : ''}${supported ? ' sd-theme-swatch' : ''}" role="menuitemradio" aria-checked="${current === theme.key}" data-theme="${escape(theme.key)}" aria-label="${escape(theme.name)}" title="${escape(theme.name)}" style="--sd-swatch:${escape(theme.dot)}">
          ${supported ? '<span aria-hidden="true"></span>' : `<span class="sd-theme-dot" style="background:${escape(theme.dot)}"></span><span class="sd-theme-name">${escape(theme.name)}</span>`}
        </button>`).join('');
    const families = ['editorial', 'glass', 'classic'].map((family, index) => `<button type="button" class="sd-theme-opt ${preference.family === family ? 'active' : ''}" role="menuitemradio" aria-checked="${preference.family === family}" data-appearance-family="${family}" aria-controls="qianmu-theme-details"><span class="sd-theme-name">${['纸间', '极简', '经典'][index]}</span></button>`).join('');
    const swatches = accents.map(([accent, name]) => `<button type="button" class="sd-theme-opt sd-theme-swatch" role="menuitemradio" aria-checked="${preference.accent === accent}" data-appearance-accent="${accent}" title="${name}" aria-label="${name}" style="--sd-swatch:${accent}"><span aria-hidden="true"></span></button>`).join('');
    return `<div class="sd-theme-pick">
      <button type="button" class="sd-theme-btn" title="外观主题" aria-label="外观主题" aria-haspopup="menu" aria-expanded="false" aria-controls="qianmu-appearance-menu"><i class="fa-solid fa-palette"></i></button>
      <div id="qianmu-appearance-menu" class="sd-theme-menu${supported ? ' is-appearance' : ''}" role="menu" aria-label="外观主题" hidden>
        ${supported ? `<div class="sd-theme-family-options" role="group" aria-label="主题">${families}</div>
        <div id="qianmu-theme-details" class="sd-theme-details" role="group" aria-label="主题颜色">
          <div class="sd-theme-classic-options" role="group" aria-label="经典颜色"${preference.family === 'classic' ? '' : ' hidden'}>${classic}</div>
          <div class="sd-theme-accent-options" role="group" aria-label="强调色"${preference.family === 'classic' ? ' hidden' : ''}>
            <div class="sd-theme-swatches"><button type="button" class="sd-theme-opt sd-theme-mode-toggle" role="menuitem" data-appearance-mode-toggle aria-label="切换至${preference.mode === 'dark' ? '日间' : '夜间'}" title="切换至${preference.mode === 'dark' ? '日间' : '夜间'}">${modeIcon(preference.mode)}</button>${swatches}<label class="sd-theme-custom-color sd-theme-swatch${accents.some(([accent]) => accent === preference.accent) ? '' : ' active'}" title="自定强调色"><span aria-hidden="true"></span><input class="sd-theme-color" type="color" value="${preference.accent}" aria-label="自定强调色"></label></div>
            <div class="sd-theme-custom-picker" hidden aria-label="自定义强调色编辑器">
              <div class="sd-theme-sv" role="slider" aria-label="饱和度与明度" tabindex="0"><i aria-hidden="true"></i></div>
              <input class="sd-theme-hue" type="range" min="0" max="360" step="1" value="0" aria-label="色相">
              <div class="sd-theme-rgb"><label>R<input type="number" min="0" max="255" data-channel="r" aria-label="红色"></label><label>G<input type="number" min="0" max="255" data-channel="g" aria-label="绿色"></label><label>B<input type="number" min="0" max="255" data-channel="b" aria-label="蓝色"></label></div>
            </div>
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
    const customPicker = menu.querySelector?.('.sd-theme-custom-picker'), sv = customPicker?.querySelector?.('.sd-theme-sv'), hue = customPicker?.querySelector?.('.sd-theme-hue');
    const rgbInputs = customPicker ? [...customPicker.querySelectorAll?.('[data-channel]') || []] : [];
    const feedback = menu.querySelector?.('.sd-theme-feedback'), status = menu.querySelector?.('.sd-theme-status'), retry = menu.querySelector?.('.sd-theme-retry');
    let disposed = false, listening = false, actionError = '', sequence = 0;
    let pickerHsv = { h: 0, s: 0, v: 1 };
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    function hexRgb(hex) {
        const raw = String(hex || '').replace(/^#/, '');
        if (!/^[a-f\d]{6}$/i.test(raw)) return { r: 0, g: 0, b: 0 };
        return { r: parseInt(raw.slice(0, 2), 16), g: parseInt(raw.slice(2, 4), 16), b: parseInt(raw.slice(4, 6), 16) };
    }
    function rgbHex({ r, g, b }) { return `#${[r, g, b].map(value => clamp(Math.round(Number(value) || 0), 0, 255).toString(16).padStart(2, '0')).join('')}`; }
    function rgbHsv({ r, g, b }) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        let h = 0;
        if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
    }
    function hsvRgb({ h, s, v }) {
        const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
        const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
        return { r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255 };
    }
    function syncPicker(hex) {
        if (!customPicker) return;
        pickerHsv = rgbHsv(hexRgb(hex));
        if (hue) hue.value = String(Math.round(pickerHsv.h));
        if (sv) {
            sv.style.backgroundImage = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${pickerHsv.h} 100% 50%))`;
            const marker = sv.querySelector?.('i');
            if (marker) { marker.style.left = `${pickerHsv.s * 100}%`; marker.style.top = `${(1 - pickerHsv.v) * 100}%`; }
        }
        const rgb = hexRgb(hex);
        for (const input of rgbInputs) input.value = String(rgb[input.dataset.channel] ?? 0);
    }
    function applyCustomHex(hex) {
        if (disposed || !appearance || appearance.read().family === 'classic' || !/^#[a-f\d]{6}$/i.test(hex)) return;
        if (color) color.value = hex.toLowerCase();
        actionError = ''; sequence++;
        try { const result = appearance.change({ accent: hex.toLowerCase(), source: 'manual' }); refresh(); settle(result); }
        catch { actionError = '颜色切换未完成，已保留原设置。'; refresh(); }
    }
    function updatePickerFromHsv() { syncPicker(rgbHex(hsvRgb(pickerHsv))); applyCustomHex(rgbHex(hsvRgb(pickerHsv))); }
    function updateSv(event) {
        if (!sv || !appearance || appearance.read().family === 'classic') return;
        const rect = sv.getBoundingClientRect?.();
        if (!rect?.width || !rect?.height) return;
        pickerHsv.s = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        pickerHsv.v = clamp(1 - (event.clientY - rect.top) / rect.height, 0, 1);
        event.preventDefault(); updatePickerFromHsv();
    }
    function updateRgb() {
        const rgb = { r: 0, g: 0, b: 0 };
        for (const input of rgbInputs) rgb[input.dataset.channel] = clamp(Number(input.value), 0, 255);
        applyCustomHex(rgbHex(rgb));
    }
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
        if (customPicker && preference.family === 'classic') customPicker.hidden = true;
        if (color && color.value !== preference.accent) color.value = preference.accent;
        syncPicker(preference.accent);
        if (customColor) {
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
        if (customPicker) customPicker.hidden = true;
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
        if (appearance) {
            // Classic colours are complete legacy palettes, not independently
            // configurable day/night accents. Keep their existing action owner.
            event.stopPropagation(); actionError = ''; sequence++;
            try { const result = onSelect(key.classic); refresh(); settle(result); }
            catch { actionError = '颜色切换未完成，已保留原设置。'; refresh(); }
            return;
        }
        event.stopPropagation(); close(true);
        if (onSelect(key.classic) === false) return;
        actionError = ''; sequence++;
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
    function toggleCustomPicker(event) {
        if (!customColor || !customPicker || !appearance || appearance.read().family === 'classic') return;
        event.preventDefault(); event.stopPropagation();
        customPicker.hidden = !customPicker.hidden;
        if (!customPicker.hidden) syncPicker(appearance.read().accent);
    }
    const onHueInput = () => { pickerHsv.h = Number(hue?.value) || 0; updatePickerFromHsv(); };
    const onSvMove = event => { if (event.buttons) updateSv(event); };
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
        if (event.target === color || event.target === hue || event.target.closest?.('.sd-theme-custom-picker')) return;
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
    customColor?.addEventListener('click', toggleCustomPicker);
    sv?.addEventListener('pointerdown', updateSv); sv?.addEventListener('pointermove', onSvMove);
    hue?.addEventListener('input', onHueInput);
    rgbInputs.forEach(input => input.addEventListener('change', updateRgb));
    if (appearance) { refresh(); settle(appearance.sync()); }
    return () => {
        if (disposed) return; disposed = true; sequence++; close();
        trigger.removeEventListener('click', toggle); menu.removeEventListener('click', select); pick.removeEventListener('keydown', keydown);
        color?.removeEventListener('input', chooseColor); color?.removeEventListener('change', chooseColor);
        customColor?.removeEventListener('click', toggleCustomPicker);
        sv?.removeEventListener('pointerdown', updateSv);
        sv?.removeEventListener('pointermove', onSvMove);
        hue?.removeEventListener('input', onHueInput);
        rgbInputs.forEach(input => input.removeEventListener('change', updateRgb));
    };
}
