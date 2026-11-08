import { createHost } from './host.mjs';
import { createApi } from './client.mjs';
import { createController } from './runtime.mjs';
import { readYimuServiceRelease } from './release-version.mjs';
import { createView, mountEntries } from './view.mjs';
import { COMPANION_READY } from './companion-runtime.mjs';

let instance = null;
export function boot() {
    if (instance || !globalThis.SillyTavern?.getContext?.() || !globalThis.document?.body) return instance;
    const notify = (message, tone = 'success') => (globalThis.document?.defaultView?.toastr || globalThis.toastr)?.[tone]?.(message);
    const getUi = () => ({ showShortcut: globalThis.SillyTavern.getContext().extensionSettings?.yimu?.showShortcut === true });
    let removeEntries = null, settledService = null;
    const host = createHost();
    // A background recheck keeps the last settled service status instead of flashing "checking".
    const render = state => {
        const ui = getUi(), status = state.service?.status;
        if (status && status !== 'checking') settledService = state.service;
        const shown = status === 'checking' && !state.loading && settledService ? { ...state, service: settledService } : state;
        view.render({ ...shown, ui }); removeEntries?.update(ui, shown);
    };
    const view = createView({ connectionApi: host.connectionApi, onNotice: notify, onAction: async (type, payload) => {
        if (type !== 'uiSettings') return controller.action(type, payload);
        const ctx = globalThis.SillyTavern.getContext();
        if (!ctx.extensionSettings || typeof ctx.saveSettingsDebounced !== 'function') throw new Error('当前 ST 尚不能保存界面设置，请稍后重试。');
        const previous = ctx.extensionSettings.yimu;
        const saved = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
        ctx.extensionSettings.yimu = { ...saved, showShortcut: payload.showShortcut === true };
        try { await ctx.saveSettingsDebounced(); }
        catch (error) { if (previous === undefined) delete ctx.extensionSettings.yimu; else ctx.extensionSettings.yimu = previous; throw error; }
        render(controller.state);
        return true;
    } });
    const controller = createController({ host, api: createApi(), onChange: render, onNotice: notify, latestService: readYimuServiceRelease });
    // Reopening a loaded chat re-reads quietly so controls never flash disabled.
    const open = () => {
        view.open();
        const current = controller.state;
        const warm = Boolean(current.snapshot && current.document && !current.loading && !current.error);
        void controller.refresh(warm ? { quiet: true, auto: false } : {});
    };
    removeEntries = mountEntries(open);
    render(controller.state);
    const unsubscribe = host.subscribe((name, args) => controller.event(name, args));
    const focus = () => { void controller.refresh({ quiet: true, auto: false }); };
    globalThis.addEventListener('focus', focus);
    globalThis.addEventListener(COMPANION_READY, focus);
    const interceptor = (...args) => controller.intercept(...args);
    globalThis.yimuGenerationInterceptor = interceptor;
    const dispose = () => {
        controller.destroy(); unsubscribe(); removeEntries(); view.destroy();
        globalThis.removeEventListener('focus', focus);
        globalThis.removeEventListener(COMPANION_READY, focus);
        globalThis.removeEventListener('pagehide', dispose);
        if (globalThis.yimuGenerationInterceptor === interceptor) delete globalThis.yimuGenerationInterceptor;
        instance = null;
    };
    globalThis.addEventListener('pagehide', dispose, { once: true });
    instance = { controller, view, dispose };
    void controller.refresh({ quiet: true, auto: true });
    return instance;
}

// ST loads extensions after exposing getContext. DOM readiness is the only deferred dependency.
if (globalThis.document?.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
