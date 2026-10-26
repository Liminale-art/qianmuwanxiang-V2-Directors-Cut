const RELEASE_MANIFEST = 'https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/refactor/storyboard-modularization/yimu/manifest.json';
const GUIDE = 'https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/blob/refactor/storyboard-modularization/yimu/README.md#安装与更新';
export function isNewerYimuVersion(current, latest) {
    const parse = value => /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null;
    const a = parse(String(current)), b = parse(String(latest));
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return b[i] > a[i]; }
    return false;
}
/** A read-only release check for the copied, paired Yimu installation, not ST's Git updater. */
export function mountYimuVersionBadge(container, { document = container?.ownerDocument || globalThis.document,
    version = '', onNotice = () => {}, fetchImpl = document?.defaultView?.fetch?.bind(document.defaultView), now = () => Date.now() } = {}) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ym-version-tag';
    let disposed = false, pending = null, checkedAt = null, available = false, unknown = false, controller;
    const paint = () => { button.textContent = available ? 'NEW' : `v${version}`; button.className = `ym-version-tag${available ? ' is-update-available' : ''}`;
        const title = available ? '发现忆幕新版本；前后端请一键成对更新' : `当前忆幕 v${version}；点击检查更新`;
        button.title = title; button.setAttribute('aria-label', title); };
    async function check({ force = false } = {}) {
        if (disposed || typeof fetchImpl !== 'function') return { available, status: 'unavailable' };
        if (!force && checkedAt !== null && now() - checkedAt < (unknown ? 60000 : 30 * 60 * 1000)) return { available, status: unknown ? 'unknown' : 'ready' };
        if (pending) return pending;
        controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
        pending = (async () => { try {
            const response = await fetchImpl(RELEASE_MANIFEST, { signal: controller.signal, cache: 'no-cache', credentials: 'omit', referrerPolicy: 'no-referrer' });
            if (!response.ok) throw new Error('版本信息暂不可用');
            const data = await response.json(); if (!/^\d+\.\d+\.\d+$/.test(String(data?.version))) throw new Error('版本信息无效');
            if (!disposed) { available = isNewerYimuVersion(version, data.version); unknown = false; checkedAt = now(); paint(); }
            return { available, status: 'ready', version: data.version };
        } catch { if (!disposed) { unknown = true; checkedAt = now(); } return { available, status: 'unknown' }; }
        finally { clearTimeout(timer); pending = null; } })();
        return pending;
    }
    const click = async () => { if (available) return onNotice(`发现忆幕新版本，请按安装说明一键成对更新前后端。`, GUIDE);
        const result = await check({ force: true }); if (disposed) return;
        onNotice(result.status === 'unknown' || result.status === 'unavailable' ? '暂时无法检查忆幕更新，请稍后重试。' : available ? '发现忆幕新版本，请一键成对更新前后端。' : '当前忆幕已是最新版本。', available ? GUIDE : ''); };
    button.addEventListener('click', click); container.append(button); paint();
    return { check, destroy() { if (disposed) return; disposed = true; controller?.abort(); button.removeEventListener?.('click', click); button.remove(); } };
}
