import {openStoryboardCaptureChooser, closeStoryboardCaptureChooser} from '/qianmu-storyboard-capture-view.js';
import {createQianmuAppearanceSession} from '/qianmu-appearance-session.js';

let settings = {theme: 'light'}, result, running = false;
const session = createQianmuAppearanceSession({document, readSettings: () => settings, styleUrl: new URL('/qianmu-theme-skins.css', location.href)});
const paragraphs = Array.from({length: 12}, (_, index) => [
    '午后的阳光落在窗边，花盆的影子轻轻投向木桌。她放下书，望向远处的花园。',
    '桌上摊着一封没有署名的信，浅蓝色信纸边缘留着折痕。风从半开的窗吹进来。',
    '走廊尽头传来轻快的脚步声。她起身，整理好衣袖，然后慢慢推开了门。',
][index % 3]);
const report = value => parent.postMessage({report: value}, location.origin);
const get = label => document.querySelector('button[aria-label="' + label + '"]');
const shown = node => Boolean(node?.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
const dialog = () => document.querySelector('.qm-storyboard-capture');
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
function open() {
    result = openStoryboardCaptureChooser({document, paragraphs, mountPortal: root => session.mountPortal(root, {inheritTheme: true}), isCurrent: () => true});
    result.then(value => { if (!running) report('面板结果：' + JSON.stringify(value)); }, error => report('ERROR: ' + error.message));
    return result;
}
async function paint(family, dark) {
    settings = {theme: dark ? 'dark' : 'light', appearance: {version: 1, family, mode: dark ? 'dark' : 'light', source: 'manual', accent: '#719688'}};
    session.repaintClassic(); await session.sync(); await nextFrame();
}
function contrast(a, b) {
    const lum = value => {
        const parts = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
        return parts[0] * .2126 + parts[1] * .7152 + parts[2] * .0722;
    };
    const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
async function tests() {
    if (running) return; running = true; const checks = [];
    const check = (value, label) => { if (!value) throw Error(label); checks.push(label); };
    try {
        closeStoryboardCaptureChooser(document);
        for (const family of ['classic', 'glass', 'editorial']) for (const dark of [false, true]) {
            await paint(family, dark); open(); await session.sync(); await nextFrame();
            check(shown(get('手动选段补图')) && shown(get('本层重新提取')), family + '/' + dark + ': choice visible');
            get('手动选段补图').click(); get('选择第 1 段').click(); await nextFrame();
            const row = get('选择第 1 段'), style = getComputedStyle(row), background = getComputedStyle(dialog()).backgroundColor;
            const ratio = contrast(style.color, style.backgroundColor), panelRatio = contrast(getComputedStyle(dialog()).color, background);
            check(ratio >= 4.5 && !style.backgroundColor.includes('rgba'), family + '/' + dark + ': opaque selected contrast ' + ratio.toFixed(2));
            check(panelRatio >= 4.5, family + '/' + dark + ': panel contrast ' + panelRatio.toFixed(2));
            check(!shown(get('手动选段补图')) && !shown(get('本层重新提取')), family + '/' + dark + ': pure paragraph page');
            check(getComputedStyle(dialog()).borderRadius === (family === 'editorial' ? '0px' : family === 'glass' ? '22px' : '16px'), family + '/' + dark + ': family geometry');
            const scroller = document.querySelector('.qm-storyboard-capture-paragraphs'); scroller.scrollTop = 140;
            get('返回插画方式').click(); get('手动选段补图').click();
            check(get('选择第 1 段') === row && row.getAttribute('aria-pressed') === 'true' && scroller.scrollTop === 140, family + '/' + dark + ': return preserves selection and scroll');
            get('继续补图').click(); const value = await result;
            check(value.mode === 'manual_supplement' && value.indexes.join() === '0', family + '/' + dark + ': selection contract');
            check(session.size === 0 && !document.querySelector('.qm-storyboard-capture-portal'), family + '/' + dark + ': cleanup');
        }
        open(); get('本层重新提取').click(); check(dialog().dataset.page === 'auto', 'auto has explicit confirmation');
        get('继续重新提取').click(); check((await result).mode === 'auto', 'auto contract');
        open(); const event = new Event('cancel', {cancelable: true}); dialog().dispatchEvent(event);
        check(event.defaultPrevented && await result === null && session.size === 0, 'native cancel cleanup');
        await paint('glass', false); open(); await session.sync(); get('手动选段补图').click(); get('选择第 1 段').click();
        report('PASS ' + checks.length + ' browser checks\n' + checks.join('\n'));
    } catch (error) { report('FAIL after ' + checks.length + ' checks: ' + error.message + '\n' + checks.join('\n')); }
    finally { running = false; }
}
window.addEventListener('message', async event => {
    if (event.origin !== location.origin || event.source !== parent || running) return;
    const {action, family, dark} = event.data || {};
    if (action === 'theme') { await paint(family, dark); report('当前：' + family + ' / ' + (dark ? 'dark' : 'light')); }
    if (action === 'open') { open(); report('已重新打开自有面板'); }
    if (action === 'tests') await tests();
});
document.querySelector('.fixture-trigger').focus(); open(); report('就绪：经典 / light。可直接操作内层面板，也可切换主题、明暗和窄屏。');
