import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fontScopeCss } from '../../qianmu-font-runtime.js';

// Bounded local-browser regression. The caller supplies local font bytes and
// the installed ST stylesheet; no network font/resource is requested. This is
// deliberately separate from the light DOM unit fixture: the browser must
// evaluate the real layered ST rule and real Qianmu theme declarations.
export async function verifyYimuFontIsolation(page, { hostStyle, firstFont, secondFont }) {
    const [themeSource, qianmuStyle, skins, yimuStyle] = await Promise.all([
        readFile(new URL('../../yimu/theme.mjs', import.meta.url), 'utf8'),
        readFile(new URL('../../style.css', import.meta.url), 'utf8'),
        readFile(new URL('../../qianmu-theme-skins.css', import.meta.url), 'utf8'),
        readFile(new URL('../../yimu/style.css', import.meta.url), 'utf8'),
    ]);
    await page.goto('about:blank');
    const result = await page.evaluate(async ({ hostStyle, firstFont, secondFont, themeSource, qianmuStyle, skins, yimuStyle, firstRule, secondRule }) => {
        document.head.innerHTML = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\' data:; font-src data:">';
        document.body.replaceChildren();
        for (const text of [hostStyle, qianmuStyle, skins, yimuStyle]) {
            const sheet = document.createElement('style'); sheet.textContent = text; document.head.append(sheet);
        }
        for (const [name, bytes] of [['QianmuFont_host', firstFont], ['QianmuFont_other', secondFont]]) {
            const face = new FontFace(name, `url(data:font/ttf;base64,${bytes})`);
            document.fonts.add(await face.load());
        }
        const hostFont = document.createElement('style'); hostFont.textContent = firstRule; document.head.append(hostFont);
        const source = document.createElement('div'); source.id = 'story-director-modal'; source.className = 'sd-theme-light';
        const reference = document.createElement('span'); reference.id = 'reference-font'; reference.textContent = '千幕字体 Qianmu'; source.append(reference);
        const root = document.createElement('dialog'); root.className = 'ym-dialog'; root.setAttribute('open', '');
        root.innerHTML = '<span id="yimu-font">忆幕字体 Yimu</span><button id="yimu-button">按钮</button><input id="yimu-input" value="输入"><select id="yimu-select"><option>选项</option></select><nav class="ym-nav-shell"><div class="ym-nav"><button class="ym-nav-button">概览</button><button class="ym-nav-button">记忆</button><button class="ym-nav-button">设置</button></div></nav>';
        const host = document.createElement('span'); host.id = 'host-font'; host.textContent = 'ST 界面';
        const menu = document.createElement('a'); menu.className = 'ym-menu-entry list-group-item'; menu.innerHTML = '<span class="ym-logo"></span><span id="menu-font">忆幕</span>';
        document.body.append(source, host, menu, root);
        const { mountTheme } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(themeSource)}`);
        const binding = mountTheme(root, { document });
        const family = id => getComputedStyle(document.getElementById(id)).fontFamily;
        const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rows = [];
        for (const theme of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) {
            hostFont.textContent = firstRule;
            source.setAttribute('data-qm-theme', theme); source.setAttribute('data-qm-mode', mode); binding.sync(); await frames();
            const expected = family('reference-font'), actual = family('yimu-font');
            root.classList.remove('qm-yimu-surface');
            const withoutIsolation = family('yimu-font');
            root.classList.add('qm-yimu-surface');
            hostFont.textContent = secondRule; binding.sync(); await frames();
            rows.push({ theme, mode, expected, actual, withoutIsolation,
                afterHostChange: family('yimu-font'), afterReference: family('reference-font'),
                controls: ['yimu-button', 'yimu-input', 'yimu-select'].map(family),
                host: family('host-font'), menu: family('menu-font') });
        }
        const widths = [...root.querySelectorAll('.ym-nav-button')].map(node => node.getBoundingClientRect().width);
        window.__yimuFontRegression = { binding, source, root };
        return { rows, widths, menuGap: getComputedStyle(menu).columnGap };
    }, { hostStyle, firstFont, secondFont, themeSource, qianmuStyle, skins, yimuStyle,
        firstRule: fontScopeCss('st', 'QianmuFont_host'), secondRule: fontScopeCss('st', 'QianmuFont_other') });
    try {
    for (const row of result.rows) {
        assert.equal(row.actual, row.expected, `${row.theme}/${row.mode}: Yimu and actual Qianmu declarations agree`);
        assert.equal(row.afterHostChange, row.afterReference, `${row.theme}/${row.mode}: all controls follow the actual theme after ST font changes`);
        assert.ok(row.controls.every(font => font === row.afterReference));
        assert.match(row.host, /QianmuFont_other/); assert.match(row.menu, /QianmuFont_other/);
        if (row.theme === 'classic') assert.match(row.afterHostChange, /QianmuFont_other/);
        else {
            assert.match(row.withoutIsolation, /QianmuFont_host/, 'negative control reproduces the real layered host override');
            assert.equal(row.afterHostChange, row.actual, 'paper/minimal fixed typography does not change with the ST interface');
            assert.doesNotMatch(row.actual, /QianmuFont_host|QianmuFont_other/);
        }
    }
    assert.ok(Math.max(...result.widths) - Math.min(...result.widths) < 1, 'navigation fills the row with equal hitboxes');
    assert.equal(result.menuGap, '10px');
    // Do not stop at CSS-family strings: inspect the actual fonts that painted
    // the reference/Yimu glyphs. Qianmu's optional external fonts are not
    // fetched; installed local faces/fallbacks must resolve identically.
    await page.cdp('DOM.enable', {}); await page.cdp('CSS.enable', {});
    const tree = await page.cdp('DOM.getDocument', {}), ids = {};
    for (const [key, selector] of Object.entries({ reference: '#reference-font', yimu: '#yimu-font', host: '#host-font' })) {
        ids[key] = (await page.cdp('DOM.querySelector', { nodeId: tree.root.nodeId, selector })).nodeId;
    }
    result.renderedFonts = [];
    for (const theme of ['classic', 'editorial', 'glass']) {
        await page.evaluate(async theme => {
            const { source, binding } = window.__yimuFontRegression;
            source.style.display = 'block'; source.setAttribute('data-qm-theme', theme); binding.sync();
            await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(resolve));
        }, theme);
        const fonts = { theme };
        for (const [key, nodeId] of Object.entries(ids)) fonts[key] = [...new Set((await page.cdp('CSS.getPlatformFontsForNode', { nodeId })).fonts.map(font => font.familyName))].sort();
        assert.ok(fonts.yimu.length, 'the browser actually rendered the sample glyphs');
        assert.deepEqual(fonts.yimu, fonts.reference, `${theme}: actual rendered faces equal Qianmu`);
        if (theme !== 'classic') assert.notDeepEqual(fonts.yimu, fonts.host);
        result.renderedFonts.push(fonts);
    }
    return result;
    } finally {
        result.markerRestored = await page.evaluate(() => {
            const fixture = window.__yimuFontRegression;
            fixture?.binding.destroy(); delete window.__yimuFontRegression;
            return !fixture?.root.classList.contains('qm-yimu-surface');
        });
        assert.equal(result.markerRestored, true);
    }
}
