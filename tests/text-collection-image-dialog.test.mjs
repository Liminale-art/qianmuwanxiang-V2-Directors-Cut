import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createTextCollectionImageDialog, TEXT_COLLECTION_IMAGE_DIALOG_STYLESHEET} from '../qianmu-text-collection-image-dialog.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const item = (text = '完整正文\r\n\r\n第二段') => ({id: 'one', text, charName: '角色甲', userName: '用户乙', createdAt: '2026-09-28T08:09:10.000Z'});
const dialog = f => f.dom.byClass('qm-collection-image-dialog');
function click(f, label) {
    const node = f.dom.get(label); assert.ok(node, `missing ${label}`); assert.ok(f.dom.visible(node), `hidden ${label}`); node.click(); return node;
}
function fixture(t, options = {}) {
    const dom = textCollectionDom(), exports = [], downloads = [], verifications = [];
    let live = true;
    dom.doc.defaultView.getComputedStyle = node => {
        assert.equal(node, dialog({dom})); return {color: 'rgb(20, 40, 60)', backgroundColor: 'rgb(245, 246, 247)', fontFamily: '"主题正文", serif'};
    };
    const view = createTextCollectionImageDialog({
        parent: dom.parent, isCurrent: () => live,
        verifyAccount: async context => { verifications.push(context); return options.verifyAccount ? options.verifyAccount(context) : true; },
        download: async (...args) => { downloads.push(args); return options.download?.(...args); },
        exportImages: async payload => {
            exports.push(payload);
            if (options.exportImages) return options.exportImages(payload);
            for (let index = 1; index <= (options.pages ?? 1); index++) await payload.download(new Blob([`png${index}`]), `image-${index}.png`);
            return {pages: options.pages ?? 1};
        },
    });
    t.after(() => view.dispose());
    return {dom, view, exports, downloads, verifications, deactivate() { live = false; }};
}

test('compact view contains only editable annotations and never renders private body text', t => {
    const f = fixture(t); assert.equal(f.view.open(item('<img src=x onerror=bad()>正文不能重复预览')), true);
    assert.equal(f.dom.get('添加标注').checked, true);
    assert.equal(f.dom.get('页眉').value, '角色甲 & 用户乙');
    assert.equal(f.dom.get('页尾').value, new Date(item().createdAt).toLocaleDateString('zh-CN'));
    assert.equal(f.dom.all().filter(node => node.tagName === 'TEXTAREA').length, 2);
    assert.equal(f.dom.all().filter(node => node.tagName === 'IMG').length, 0);
    assert.equal(dialog(f).textContent.includes('正文不能重复预览'), false);
    assert.equal(f.exports.length, 0); assert.equal(f.downloads.length, 0);
    assert.equal(TEXT_COLLECTION_IMAGE_DIALOG_STYLESHEET.pathname.endsWith('/qianmu-text-collection-image-dialog.css'), true);
});

test('downloads fixed original text and edited marks using actual theme colors and font', async t => {
    const f = fixture(t), original = item(); f.view.open(original); original.text = '外部改写';
    f.dom.get('页眉').value = '自定义名字\n新行'; f.dom.get('页尾').value = '我的日期';
    click(f, '下载图片'); await turn();
    const payload = f.exports[0];
    assert.equal(payload.text, item().text); assert.equal(payload.header, '自定义名字\n新行'); assert.equal(payload.footer, '我的日期');
    assert.equal(payload.foreground, 'rgb(20, 40, 60)'); assert.equal(payload.background, 'rgb(245, 246, 247)');
    assert.equal(payload.fontFamily, '"主题正文", serif'); assert.equal(payload.document, f.dom.doc);
    assert.equal(f.verifications.length, 2); assert.equal(f.downloads.length, 1);
    assert.equal(f.downloads[0][1], 'image-1.png'); assert.equal(await f.downloads[0][0].text(), 'png1');
    assert.equal(f.dom.status().textContent, '已发起 1 张图片下载。'); assert.equal(dialog(f).open, true);
});

test('image export prefers current prose font and doubles its CSS pixel size rather than the UI font', async t => {
    const f = fixture(t); let cssSize = '18px';
    f.dom.doc.defaultView.getComputedStyle = () => ({color: '#234567', backgroundColor: '#fffdf8', fontFamily: 'UI sans-serif',
        getPropertyValue: name => name === '--qm-prose-font' ? '"正文宋体", serif' : name === '--qm-prose-size' ? cssSize : ''});
    f.view.open(item()); click(f, '下载图片'); await turn();
    assert.equal(f.exports[0].fontFamily, '"正文宋体", serif'); assert.equal(f.exports[0].fontSize, 36);
    cssSize = '22px'; click(f, '下载图片'); await turn();
    assert.equal(f.exports[1].fontSize, 44);
    assert.equal(f.exports[1].text, item().text);
});

test('missing or unresolved prose pixels use the engine default without interpreting CSS expressions', async t => {
    const f = fixture(t); let cssSize = 'calc(18px + 4px)';
    f.dom.doc.defaultView.getComputedStyle = () => ({color: '#234567', backgroundColor: '#fffdf8', fontFamily: 'serif',
        getPropertyValue: name => name === '--qm-prose-size' ? cssSize : ''});
    f.view.open(item());
    for (const value of ['calc(18px + 4px)', '22px; color:red', '22rem', '', 'NaNpx']) {
        cssSize = value; click(f, '下载图片'); await turn();
        assert.equal(f.exports.at(-1).fontSize, undefined); assert.equal(f.exports.at(-1).fontFamily, 'serif');
    }
});

test('disabled annotations pass empty strings while keeping edits for toggling back on', async t => {
    const f = fixture(t); f.view.open(item()); f.dom.get('页眉').value = '保留编辑';
    click(f, '添加标注'); assert.equal(f.dom.visible(f.dom.get('页眉')), false);
    click(f, '下载图片'); await turn();
    assert.equal(f.exports[0].header, ''); assert.equal(f.exports[0].footer, '');
    click(f, '添加标注'); assert.equal(f.dom.get('页眉').value, '保留编辑');
});

test('every page verifies the account independently without reading or modifying the collection', async t => {
    const f = fixture(t, {pages: 5}); f.view.open(item()); click(f, '下载图片'); await turn();
    assert.equal(f.exports.length, 1); assert.equal(f.downloads.length, 5); assert.equal(f.verifications.length, 6);
    assert.match(f.dom.status().textContent, /^已发起 5 张图片下载/);
    assert.match(f.dom.status().textContent, /允许浏览器下载多个文件/);
    assert.equal(f.dom.status().textContent.includes('相册'), false);
});

test('account guard failure before export prevents any image work or download', async t => {
    const f = fixture(t, {verifyAccount: () => false}); f.view.open(item()); click(f, '下载图片'); await turn();
    assert.equal(f.exports.length, 0); assert.equal(f.downloads.length, 0);
    assert.equal(f.dom.status().textContent, '未导出图片，请重试。');
    assert.equal(f.dom.get('页眉').value, '角色甲 & 用户乙');
});

test('account guard failure on a later page stops without claiming a complete download', async t => {
    let checks = 0;
    const f = fixture(t, {pages: 4, verifyAccount: () => ++checks < 3}); f.view.open(item()); click(f, '下载图片'); await turn();
    assert.equal(f.downloads.length, 1); assert.equal(f.verifications.length, 3);
    assert.equal(f.dom.status().textContent, '已发起 1 张图片下载，后续导出未完成，请重试。');
});

test('closing while identity check is pending cancels before any export begins', async t => {
    const pending = gate(), f = fixture(t, {verifyAccount: () => pending.promise}); f.view.open(item()); click(f, '下载图片');
    const scope = f.verifications[0]; assert.equal(scope.signal.aborted, false);
    click(f, '关闭收藏存图'); pending.resolve(true); await turn();
    assert.equal(scope.signal.aborted, true); assert.equal(scope.isCurrent(), false);
    assert.equal(f.exports.length, 0); assert.equal(f.downloads.length, 0); assert.equal(dialog(f), undefined);
});

test('closing during per-page verification cancels that download', async t => {
    const pending = gate(); let checks = 0;
    const f = fixture(t, {verifyAccount: () => ++checks === 1 ? true : pending.promise});
    f.view.open(item()); click(f, '下载图片'); await turn(); assert.equal(f.exports.length, 1);
    f.view.close(); pending.resolve(true); await turn();
    assert.equal(f.downloads.length, 0); assert.equal(f.exports[0].signal.aborted, true);
});

test('same button stops the active job and does not start a concurrent export', async t => {
    const pending = gate();
    const f = fixture(t, {exportImages: async payload => { await pending.promise; await payload.download(new Blob(['late']), 'late.png'); }});
    f.view.open(item()); click(f, '下载图片'); await turn();
    assert.equal(f.dom.get('添加标注').disabled, true); assert.equal(f.dom.get('页眉').disabled, true);
    assert.equal(dialog(f).getAttribute('aria-busy'), 'true');
    click(f, '停止导出'); assert.equal(f.exports[0].signal.aborted, true);
    assert.equal(f.dom.status().textContent, '已停止。'); assert.equal(f.dom.get('页眉').disabled, false);
    pending.resolve(); await turn(); assert.equal(f.downloads.length, 0); assert.equal(f.exports.length, 1);
});

test('stopping after completed pages reports only the downloads already initiated', async t => {
    const pending = gate();
    const f = fixture(t, {exportImages: async payload => { await payload.download(new Blob(['one']), 'one.png'); await pending.promise; await payload.download(new Blob(['two']), 'two.png'); }});
    f.view.open(item()); click(f, '下载图片'); await turn(); click(f, '停止导出');
    assert.equal(f.dom.status().textContent, '已停止。已发起 1 张图片下载。');
    pending.resolve(); await turn(); assert.equal(f.downloads.length, 1);
});

test('late completion or failure from a replaced export cannot alter a newly opened item', async t => {
    const pending = gate();
    const f = fixture(t, {exportImages: async () => { await pending.promise; throw Error('old private details'); }});
    f.view.open(item()); click(f, '下载图片'); await turn();
    assert.equal(f.view.open({...item('新正文'), charName: '新角色'}), true);
    assert.equal(f.exports[0].signal.aborted, true); pending.resolve(); await turn();
    assert.equal(dialog(f).open, true); assert.equal(f.dom.get('页眉').value, '新角色 & 用户乙');
    assert.equal(f.dom.status().textContent, ''); assert.equal(f.dom.get('下载图片').disabled, false);
});

test('queued native close from a previous window cannot close an immediate reopening', async t => {
    const f = fixture(t); f.view.open(item()); f.view.close(); f.view.open({...item(), charName: '再次打开'}); await turn();
    assert.equal(dialog(f).open, true); assert.equal(f.dom.get('页眉').value, '再次打开 & 用户乙');
});

test('ordinary export errors keep annotations for explicit retry and never expose error internals', async t => {
    let attempts = 0;
    const f = fixture(t, {exportImages: async payload => { if (++attempts === 1) throw Error('private account detail'); await payload.download(new Blob(['ok']), 'ok.png'); }});
    f.view.open(item()); f.dom.get('页眉').value = '我编辑的页眉'; click(f, '下载图片'); await turn();
    assert.equal(f.dom.status().textContent, '未导出图片，请重试。'); assert.equal(f.dom.get('页眉').value, '我编辑的页眉');
    click(f, '下载图片'); await turn(); assert.equal(f.exports[1].header, '我编辑的页眉'); assert.equal(f.downloads.length, 1);
});

test('a downloader rejecting or returning false is not counted as a saved image', async t => {
    const f = fixture(t, {download: () => false}); f.view.open(item()); click(f, '下载图片'); await turn();
    assert.equal(f.dom.status().textContent, '未导出图片，请重试。');
});

test('owner invalidation during export prevents further downloads and clears private dialog state', async t => {
    const pending = gate();
    const f = fixture(t, {exportImages: async payload => { await pending.promise; await payload.download(new Blob(['late']), 'late.png'); }});
    f.view.open(item()); click(f, '下载图片'); await turn(); const header = f.dom.get('页眉');
    f.deactivate(); pending.resolve(); await turn();
    assert.equal(f.downloads.length, 0); assert.equal(dialog(f), undefined); assert.equal(header.value, '');
    assert.equal(f.exports[0].signal.aborted, true); assert.equal(f.view.open(item()), false);
});

test('all local edit and click events are isolated without preventing normal input defaults', t => {
    const f = fixture(t); const types = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change', 'paste', 'cut', 'click'];
    let outside = 0; for (const type of types) f.dom.parent.addEventListener(type, () => outside++);
    f.view.open(item());
    for (const type of types) assert.equal(f.dom.get('页眉').emit(type).defaultPrevented, false);
    assert.equal(outside, 0);
    const external = f.dom.doc.createElement('input'); f.dom.parent.append(external); external.emit('input'); assert.equal(outside, 1);
});

test('escape closes once, restores original focus, and dispose is final', t => {
    const f = fixture(t), trigger = f.dom.doc.createElement('button'); f.dom.parent.append(trigger); trigger.focus();
    f.view.open(item()); assert.equal(dialog(f).emit('cancel').defaultPrevented, true);
    assert.equal(dialog(f), undefined); assert.equal(f.dom.doc.activeElement, trigger);
    f.view.dispose(); f.view.dispose(); assert.equal(f.view.open(item()), false);
});

test('invalid items do not replace the existing valid annotation snapshot', t => {
    const f = fixture(t); f.view.open(item()); f.dom.get('页眉').value = '正在编辑';
    for (const value of [null, item(' \t\n'), {...item(), createdAt: 'bad-date'}, {...item(), charName: null}]) {
        assert.equal(f.view.open(value), false);
    }
    assert.equal(f.dom.get('页眉').value, '正在编辑');
});

test('missing download or account capabilities fail only on export and never bypass verification', async t => {
    const dom = textCollectionDom(); let exports = 0;
    for (const capabilities of [{}, {download: () => {}}, {verifyAccount: () => true}]) {
        const view = createTextCollectionImageDialog({parent: dom.parent, isCurrent: () => true, exportImages: () => exports++, ...capabilities});
        assert.equal(view.open(item()), true); dom.get('下载图片').click(); await turn();
        assert.equal(dom.status().textContent, '当前无法下载图片，请重新打开。'); view.dispose();
    }
    assert.equal(exports, 0);
});

test('image settings CSS stays scoped, compact, and removes focused text outlines', async () => {
    const css = await readFile(TEXT_COLLECTION_IMAGE_DIALOG_STYLESHEET, 'utf8');
    assert.match(css, /width:\s*min\(380px, calc\(100vw - 28px\)\)/);
    const root = css.match(/\.qm-collection-image-dialog\s*\{([^}]+)\}/)?.[1];
    assert.match(root, /height:\s*fit-content;/);
    assert.match(root, /min-height:\s*0;/);
    assert.doesNotMatch(root, /height:\s*auto;/);
    assert.match(root, /max-height:\s*calc\(100dvh - 40px\);/);
    assert.match(css, /\.qm-collection-image-dialog textarea:focus-visible\s*\{\s*outline: none !important; box-shadow: none !important;/);
    for (const rule of css.split('}').map(value => value.trim()).filter(Boolean)) assert.match(rule, /^\.qm-collection-image-dialog/);
});

test('default engine and dialog integrate through complete pagination and one released canvas', async t => {
    const dom = textCollectionDom(), createElement = dom.doc.createElement;
    const canvases = [], files = [], drawn = [];
    let checks = 0;
    dom.doc.defaultView.getComputedStyle = () => ({color: 'rgb(20, 30, 40)', backgroundColor: 'rgb(255, 255, 255)', fontFamily: 'serif'});
    dom.doc.createElement = tag => {
        const node = createElement(tag);
        if (tag === 'canvas') {
            canvases.push(node);
            const context = {font: '', measureText(text) { return {width: Array.from(text).length * Number.parseFloat(this.font)}; },
                fillRect() {}, fillText(text) { drawn.push(text); }};
            node.getContext = () => context;
            node.toBlob = callback => callback(new Blob(['synthetic png'], {type: 'image/png'}));
        }
        return node;
    };
    const view = createTextCollectionImageDialog({parent: dom.parent, isCurrent: () => true,
        verifyAccount: async () => { checks++; return true; }, download: async (blob, filename) => files.push({blob, filename})});
    t.after(() => view.dispose());
    const text = '完整正文'.repeat(500) + '结尾标记';
    assert.equal(view.open(item(text)), true); dom.get('添加标注').click(); dom.get('下载图片').click();
    await dom.wait(() => dom.get('下载图片') && files.length > 0);
    assert.ok(files.length > 3); assert.equal(drawn.join(''), text);
    assert.equal(checks, files.length + 1); assert.equal(canvases.length, 1);
    assert.equal(canvases[0].width, 0); assert.equal(canvases[0].height, 0);
    assert.match(dom.status().textContent, new RegExp(`^已发起 ${files.length} 张图片下载`));
});
