const GUIDE = 'https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/blob/refactor/storyboard-modularization/INSTALL-SERVER-PLUGIN.md#忆幕随千幕统一更新';
export function isNewerYimuVersion(current, latest) {
    const parse = value => /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null;
    const a = parse(String(current)), b = parse(String(latest));
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return b[i] > a[i]; }
    return false;
}
/**
 * The Yimu folder is a child component of the Qianmu release.  It deliberately
 * does not query a second remote manifest: that made the badge report a newer
 * source revision even when the running ST extension had not been replaced.
 * Qianmu's update command is the single update authority for the paired files.
 */
export function mountYimuVersionBadge(container, { document = container?.ownerDocument || globalThis.document,
    version = '', onNotice = () => {} } = {}) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ym-version-tag';
    let disposed = false;
    const paint = () => { button.textContent = `v${version}`; button.className = 'ym-version-tag';
        const title = `忆幕 v${version}；随千幕统一更新`;
        button.title = title; button.setAttribute('aria-label', title); };
    const check = async () => ({ available: false, status: 'paired', version });
    const click = () => { if (!disposed) onNotice(`忆幕前端 v${version} 的修订请使用忆幕安装器落盘；服务端未变更时无需单独升级服务端功能。`, GUIDE); };
    button.addEventListener('click', click); container.append(button); paint();
    return { check, latest: () => version, destroy() { if (disposed) return; disposed = true; button.removeEventListener?.('click', click); button.remove(); } };
}

// Yimu service releases are versioned on their own (yimu/package.json), so a
// Yimu-only install still learns about server updates. Read-only, no account
// data, bounded size and time, cached; failures simply show no update.
const SERVICE_PACKAGE = 'https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/refactor/storyboard-modularization/yimu/package.json';
const SERVICE_MAX_BYTES = 16 * 1024, SERVICE_MAX_AGE = 30 * 60 * 1000, SERVICE_FAILURE_AGE = 60 * 1000;
async function fetchServiceVersion(url, fetchImpl, timeoutMs) {
    const controller = new AbortController(); let timer;
    const reading = (async () => {
        const response = await fetchImpl(url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal: controller.signal });
        if (!response?.ok || response.redirected || Number(response.headers?.get?.('content-length')) > SERVICE_MAX_BYTES) { controller.abort(); return ''; }
        const text = await response.text();
        if (typeof text !== 'string' || text.length > SERVICE_MAX_BYTES) return '';
        const pkg = JSON.parse(text), version = pkg?.version;
        return pkg?.name === 'yimu' && typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : '';
    })();
    try { return await Promise.race([reading, new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(''); }, timeoutMs); })]); }
    catch { return ''; }
    finally { clearTimeout(timer); }
}
export function createYimuServiceReleaseReader({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 5000 } = {}) {
    let cached = null, pending = null, serial = 0;
    return async ({ force = false } = {}) => {
        if (typeof fetchImpl !== 'function') return '';
        if (pending) return pending;
        const age = cached ? now() - cached.at : Infinity;
        if (!force && cached && age >= 0 && age < (cached.version ? SERVICE_MAX_AGE : SERVICE_FAILURE_AGE)) return cached.version;
        const url = `${SERVICE_PACKAGE}?yimu_release=${Math.max(0, Math.floor(Number(now()) || 0))}-${++serial}`;
        pending = fetchServiceVersion(url, fetchImpl, Math.max(1, Math.min(5000, Number(timeoutMs) || 5000)))
            .then(version => { cached = { version, at: now() }; pending = null; return version; });
        return pending;
    };
}
export const readYimuServiceRelease = createYimuServiceReleaseReader();
export const YIMU_SERVICE_UPDATE_GUIDE = GUIDE;
