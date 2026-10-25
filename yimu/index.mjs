import { createHost } from './host.mjs';
import { createApi } from './client.mjs';
import { createController } from './runtime.mjs';
import { createView, mountEntries } from './view.mjs';

let instance = null;
export function boot() {
    if (instance || !globalThis.SillyTavern?.getContext?.() || !globalThis.document?.body) return instance;
    const view = createView({ onAction: (type, payload) => controller.action(type, payload) });
    const host = createHost();
    const controller = createController({ host, api: createApi(), onChange: state => view.render(state) });
    const open = () => { view.open(); void controller.refresh(); };
    const removeEntries = mountEntries(open);
    const unsubscribe = host.subscribe((name, args) => controller.event(name, args));
    const focus = () => { void controller.refresh({ quiet: true, auto: false }); };
    globalThis.addEventListener('focus', focus);
    const interceptor = (...args) => controller.intercept(...args);
    globalThis.yimuGenerationInterceptor = interceptor;
    const dispose = () => {
        controller.destroy(); unsubscribe(); removeEntries(); view.destroy();
        globalThis.removeEventListener('focus', focus);
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
