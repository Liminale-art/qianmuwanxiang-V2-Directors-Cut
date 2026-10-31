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
    const click = () => { if (!disposed) onNotice('忆幕随千幕统一更新，请使用千幕更新命令。', GUIDE); };
    button.addEventListener('click', click); container.append(button); paint();
    return { check, latest: () => version, destroy() { if (disposed) return; disposed = true; button.removeEventListener?.('click', click); button.remove(); } };
}
