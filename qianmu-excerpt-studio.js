// 书摘成图 · 排版台：仿演示文稿的编辑页。页面画在影子根里（模板样式与 ST 互不影响），
// 选中框、手柄与小工具条在外层。所有改动只作用于这份成图稿，不回写收藏原文。
import {PAGE_WIDTH, RATIOS, PAGE_BREAK, pageHeight, normalizeDoc, normalizeBody, normalizeElement, createDoc, createDocFromScheme,
    schemeFromDoc, setRatio, makeContinuationPage, normalizeStudioSettings, builtinTemplate, newId, normalizeLines, normalizeCustomRatio, GRAIN_SIZES,
    SCHEME_LIMIT, TEMPLATE_LIMIT, BLEND_MODES} from './features/excerpt/qianmu-excerpt-doc.js';
import {BUILTIN_TEMPLATES, parseExcerptTemplate, TEMPLATE_GUIDE, TEMPLATE_STARTER, normalizeHex} from './features/excerpt/qianmu-excerpt-template.js';
import {BASE_CSS, FONT_STACKS, buildPage, buildElement, buildGrain, pageStyle, elementCss, createGrainTiles, fillParagraphs, createMeasurer, layoutDoc, embedFonts,
    pageSvg, svgToPng, blobToDataUrl, imageGeometry} from './features/excerpt/qianmu-excerpt-render.js';
import {createExcerptStore, prepareImage, imageIdsOf} from './features/excerpt/qianmu-excerpt-store.js';

export {excerptFields} from './features/excerpt/qianmu-excerpt-template.js';
export const EXCERPT_STUDIO_STYLESHEET = new URL('./qianmu-excerpt-studio.css', import.meta.url);

const EDITOR_CSS = `
.page{user-select:none;-webkit-user-select:none}
.qm-body{outline:1px dashed color-mix(in srgb,currentColor 26%,transparent);outline-offset:-1px}
.qm-editing{overflow:visible!important;outline:2px solid #4a8cff!important;outline-offset:2px;cursor:text;user-select:text!important;-webkit-user-select:text!important}
.qm-cropping{overflow:visible!important;outline:2px dashed #4a8cff;outline-offset:2px}
.qm-cropping>img{opacity:.6}
`;

const ICONS = {
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    template: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M10 10v10"/>',
    scheme: '<path d="M6 4h12v16l-6-4-6 4z"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    preview: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    prev: '<path d="m15 5-7 7 7 7"/>',
    next: '<path d="m9 5 7 7-7 7"/>',
    unfull: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    text: '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="m3 5 18 14M21 5 3 19"/>',
    line: '<path d="M5 19 19 5"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
    talk: '<path d="M4 5h16v10H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
    page: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
    top: '<path d="M5 4h14M12 20V9M7 13l5-5 5 5"/>',
    up: '<path d="M12 19V6M7 11l5-5 5 5"/>',
    down: '<path d="M12 5v13M7 13l5 5 5-5"/>',
    bottom: '<path d="M5 20h14M12 4v11M7 11l5 5 5-5"/>',
    layers: '<path d="m12 4 8 4-8 4-8-4z"/><path d="m4 12 8 4 8-4M4 16l8 4 8-4"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V4H4v12h4"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    crop: '<path d="M6 2v16h16M2 6h16v16"/>',
    breakpage: '<path d="M6 3v6h12V3M6 21v-6h12v6M3 12h3M9 12h2M13 12h2M18 12h3"/>',
    merge: '<path d="M6 3v6h12V3M6 21v-6h12v6M8 12h8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    fit: '<rect x="5" y="5" width="14" height="14" rx="1"/><path d="M9 12h6M12 9v6"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    more: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
    pointer: '<path d="M6 3.5 18.5 12l-5.6 1.2 3.1 6.1-2.4 1.2-3.1-6.1L6 18.3z"/>',
    multi: '<rect x="3.5" y="3.5" width="10" height="10" rx="1.5" stroke-dasharray="2.2 2.2"/><rect x="10.5" y="10.5" width="10" height="10" rx="1.5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M4 4l16 16"/><path d="M9.9 5.8A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.7 3.4M6.4 7.3C3.9 9 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    move: '<path d="M12 3v18M3 12h18M9.5 5.5 12 3l2.5 2.5M9.5 18.5 12 21l2.5-2.5M5.5 9.5 3 12l2.5 2.5M18.5 9.5 21 12l-2.5 2.5"/>',
    drop: '<path d="M12 3.5s6 6.3 6 10.4a6 6 0 0 1-12 0C6 9.8 12 3.5 12 3.5z"/>',
    body: '<path d="M5 6h14M5 10h14M5 14h14M5 18h9"/>',
};
const KIND_LABEL = {text: '文本框', body: '正文框', image: '图片框', line: '线条', rect: '矩形', ellipse: '圆形', dialog: '书友对话'};
const KIND_ICON = {text: 'text', body: 'body', image: 'image', line: 'line', rect: 'rect', ellipse: 'ellipse', dialog: 'talk'};
const TEXT_KINDS = new Set(['text', 'body', 'dialog']);
const BLEND_LABEL = {normal: '正常', multiply: '正片叠底', screen: '滤色', overlay: '叠加', darken: '变暗', lighten: '变亮', 'color-dodge': '颜色减淡',
    'color-burn': '颜色加深', 'hard-light': '强光', 'soft-light': '柔光', difference: '差值', exclusion: '排除', hue: '色相', saturation: '饱和度', color: '颜色', luminosity: '明度'};
const EDITABLE = new Set(['text', 'body', 'dialog']);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = value => Math.round(value * 100) / 100;

function hexRgb(hex) { const raw = hex.slice(1); return [0, 2, 4].map(at => Number.parseInt(raw.slice(at, at + 2), 16)); }
function rgbHex(rgb) { return `#${rgb.map(value => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')).join('')}`; }
function rgbHsv([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return {h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max};
}
function hsvRgb({h, s, v}) {
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return rgb.map(value => (value + m) * 255);
}
function cssColorHex(value) {
    const match = /rgba?\(([^)]+)\)/.exec(String(value || ''));
    if (!match) return normalizeHex(value, '');
    return rgbHex(match[1].split(/[\s,/]+/).slice(0, 3).map(Number));
}
function safeName(value) { return Array.from(String(value || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim()).slice(0, 40).join('') || '书摘'; }
// settings：{read, write} 账户设置里的书摘成图资料；fonts：异步取字体库提供者（list/family/faces/release）；
// download(blob, name)：本机保存；verifyAccount：每张图保存前核一次账户；namespace：本机稿件按账户分开。
export function createExcerptStudio({parent, settings, fonts, download, verifyAccount, isCurrent = () => true, namespace} = {}) {
    const document = parent?.ownerDocument, view = document?.defaultView;
    if (!document || typeof download !== 'function') throw new TypeError('书摘成图缺少宿主');
    let disposed = false, visible = false, stylesheet = null, store = null;
    let content = null, doc = null, layout = {pages: [], remaining: 0, stuck: false}, pageIndex = 0, pageNode = null, pageH = 1440;
    let statusMessage = '', exportShown = null, miniKey = '', miniSize = null, sheetOffset = null, preview = null, panelShows = null;
    const layoutHints = new Map(), overlayNodes = new Map(), grainTiles = createGrainTiles(document);
    // picks：当前页上选中的元素（按点选先后），selected 是最后点的那个（单选时就是它）。tool：select 单选／multi 多选（点一下加减）。
    let selected = null, picks = [], tool = 'select', editing = null, cropping = null, drag = null, guides = [];
    let panelTab = 'props', propsDirty = false, layersKey = '';
    let history = [], future = [], lastKey = '', lastAt = 0, dirtyLast = false;
    let scale = 1, zoom = 0, measurer = null, measurerCss = null, relayoutToken = 0;
    let fontProvider = null, fontList = [], exportJob = null, pickTarget = null, popClose = null, swept = false;
    let saveTimer = null, lastTimer = null, thumbTimer = null, statusTimer = null;
    const families = new Map(), fontFailed = new Set(), imageUrls = new Map(), recentColors = [];

    const make = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const icon = name => {
        const span = make('span', 'qm-xs-icon');
        span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
        return span;
    };
    function button(label, iconName, action, {className = '', text = false, keepFocus = false} = {}) {
        const node = make('button', `qm-xs-btn${text ? ' has-label' : ''}${className ? ` ${className}` : ''}`);
        node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
        if (iconName) node.append(icon(iconName));
        if (text) node.append(make('span', 'qm-xs-label', typeof text === 'string' ? text : label));
        if (keepFocus) node.addEventListener('pointerdown', event => event.preventDefault());
        node.addEventListener('click', event => { if (!node.disabled) action(event); });
        return node;
    }
    const textButton = (label, action, className = '') => {
        const node = make('button', `qm-xs-tbtn${className ? ` ${className}` : ''}`, label);
        node.type = 'button';
        node.addEventListener('click', event => { if (!node.disabled) action(event); });
        return node;
    };

    const dialog = make('dialog', 'qm-xs');
    dialog.setAttribute('aria-label', '书摘成图');
    const top = make('header', 'qm-xs-top');
    const undoButton = button('撤销', 'undo', () => undo()), redoButton = button('重做', 'redo', () => redo());
    const templateButton = button('模板', 'template', event => openTemplateMenu(event.currentTarget));
    const schemeButton = button('方案', 'scheme', event => openSchemeMenu(event.currentTarget));
    const status = make('span', 'qm-xs-status'); status.setAttribute('role', 'status');
    const fullButton = button('全屏', 'full', () => onFullButton());
    const exportButton = button('导出图片', 'download', () => exportJob ? exportJob.controller.abort() : void startExport(), {className: 'qm-xs-primary'});
    top.append(button('关闭', 'close', () => close()), make('i', 'qm-xs-sep'), undoButton, redoButton, make('i', 'qm-xs-sep'),
        templateButton, schemeButton, status, fullButton, exportButton);

    // 排布：宽屏左侧竖排工具条、中间画面与页面条、右侧「属性／图层」；窄屏依次是画面、属性抽屉、页面条、底部工具条（见样式表）。
    const stageWrap = make('div', 'qm-xs-stagewrap'), stage = make('div', 'qm-xs-stage'), sheet = make('div', 'qm-xs-sheet');
    const canvas = make('div', 'qm-xs-canvas'), host = make('div', 'qm-xs-host'), overlay = make('div', 'qm-xs-overlay'), mini = make('div', 'qm-xs-mini');
    const shadow = host.attachShadow({mode: 'open'});
    canvas.append(host, overlay); sheet.append(canvas, mini); stage.append(sheet);
    const zoomBar = make('div', 'qm-xs-zoom');
    zoomBar.append(button('缩小', 'minus', () => zoomBy(0.8)), button('适应窗口', 'fit', () => { zoom = 0; fit(); }), button('放大', 'plus', () => zoomBy(1.25)));
    stageWrap.append(stage, zoomBar);
    // 工具条：选择与多选是两种点选方式，其余按一下就在画面里加一个元素。以后的形状、取色等工具接在插入组后面。
    const tools = make('nav', 'qm-xs-tools'); tools.setAttribute('aria-label', '工具');
    const selectTool = button('选择', 'pointer', () => setTool('select'), {className: 'qm-xs-tool'});
    const multiTool = button('多选', 'multi', () => setTool(tool === 'multi' ? 'select' : 'multi'), {className: 'qm-xs-tool'});
    multiTool.title = '多选（Shift＋点选）';
    const dialogueButton = button('书友对话', 'talk', () => addElement('dialog'));
    dialogueButton.hidden = true;
    const insertGroup = make('div', 'qm-xs-tool-group');
    insertGroup.append(button('文本框', 'text', () => addElement('text')), button('图片框', 'image', () => addElement('image')),
        button('线条', 'line', () => addElement('line')), button('矩形', 'rect', () => addElement('rect')),
        button('圆形', 'ellipse', () => addElement('ellipse')), dialogueButton);
    const pageTool = button('页面设置', 'page', () => { commitEditing(); select(null); showTab('props', true); }, {className: 'qm-xs-tool-end'});
    tools.append(selectTool, multiTool, make('i', 'qm-xs-sep'), insertGroup, pageTool);
    const panel = make('aside', 'qm-xs-panel'), panelHead = make('div', 'qm-xs-panel-head'), tabList = make('div', 'qm-xs-tabs');
    tabList.setAttribute('role', 'tablist');
    const tabButton = (key, label) => {
        const node = make('button', 'qm-xs-tab', label); node.type = 'button';
        node.setAttribute('role', 'tab'); node.dataset.tab = key;
        node.addEventListener('click', () => showTab(key, true));
        return node;
    };
    const propsTab = tabButton('props', '属性'), layersTab = tabButton('layers', '图层');
    tabList.append(propsTab, layersTab);
    const panelBody = make('div', 'qm-xs-panel-body'), layersBody = make('div', 'qm-xs-panel-body qm-xs-layers');
    panelBody.setAttribute('role', 'tabpanel'); layersBody.setAttribute('role', 'tabpanel');
    const collapseButton = button('收起', 'chevron', () => { panel.classList.toggle('is-collapsed'); requestAnimationFrame(fit); }, {className: 'qm-xs-collapse'});
    panelHead.append(tabList, collapseButton); panel.append(panelHead, panelBody, layersBody);
    const strip = make('nav', 'qm-xs-pages'); strip.setAttribute('aria-label', '页面');
    const pop = make('div', 'qm-xs-pop'); pop.hidden = true;
    const editor = make('section', 'qm-xs-tpl-editor'); editor.hidden = true;
    const imageInput = make('input'); imageInput.type = 'file'; imageInput.accept = 'image/*'; imageInput.hidden = true;
    const templateInput = make('input'); templateInput.type = 'file'; templateInput.accept = '.html,.htm,.txt,text/html,text/plain'; templateInput.hidden = true;
    dialog.append(top, tools, stageWrap, panel, strip, pop, editor, imageInput, templateInput);
    // 编辑页里的按键与输入不传给 ST（免得触发 ST 的快捷键）。
    for (const type of ['keyup', 'keypress', 'beforeinput', 'input', 'change', 'paste', 'cut', 'copy', 'click', 'wheel']) dialog.addEventListener(type, event => event.stopPropagation());
    // ── 状态、撤销与保存 ──────────────────────────────────────────────────
    const current = () => { if (disposed) return false; try { return isCurrent() === true; } catch { return false; } };
    const readSettings = () => { try { return normalizeStudioSettings(settings?.read?.()); } catch { return normalizeStudioSettings(null); } };
    function writeSettings(mutate) {
        const next = readSettings();
        if (mutate(next) === false) return false;
        try { settings?.write?.(next); return true; } catch (error) { console.warn('[千幕] 书摘设置未保存', error); setStatus('设置未能保存'); return false; }
    }
    // 状态栏平时显示这份稿的版式名（模板名或方案名，改过版式就是「未命名」）；临时消息过几秒退回版式名。
    function setStatus(text, sticky = false) {
        statusMessage = text || '';
        clearTimeout(statusTimer);
        if (text && !sticky) statusTimer = setTimeout(() => { if (statusMessage === text) { statusMessage = ''; paintStatus(); } }, 4000);
        paintStatus();
    }
    function paintStatus() {
        const text = statusMessage || (doc ? doc.name || '未命名' : '');
        if (status.textContent !== text) { status.textContent = text; status.title = text; }
    }
    const snapshot = () => JSON.stringify(doc);
    function remember(key = '') {
        const now = Date.now();
        if (key && key === lastKey && now - lastAt < 900) { lastAt = now; return; }
        pushHistory(snapshot()); lastKey = key; lastAt = now;
    }
    function pushHistory(value) { history.push(value); if (history.length > 50) history.shift(); future = []; lastKey = ''; }
    // keepName：只改了文字内容（或换模板、方案时由它们自己定名），版式名不变；其余改动都让版式变成「未命名」。
    function changed({keepName = false} = {}) {
        if (doc && !keepName) doc.name = '';
        dirtyLast = true; scheduleSave(); updateTop(); paintStatus();
    }
    // paint：不重排时只重画受影响的部分——{element: id} 或 {elements: [id…]} 只换这几个框（restyle 时连框也不换，只改它的行内样式），
    // 'paper' 只改纸色、文字色、杂色与背景透明度。
    function change(mutate, {key = '', reflow = true, keepName = false, paint = null} = {}) {
        if (!doc || exportJob) return Promise.resolve();
        remember(key); mutate(doc); changed({keepName});
        if (reflow) return relayout();
        if (paint === 'paper') { paintPaper(); scheduleThumbs(); }
        else if (paint?.element || paint?.elements) {
            const ids = paint.elements || [paint.element], page = pageOf(ids[0]);
            const elements = ids.map(findElement).filter(Boolean);
            if (page === currentPage() && elements.every(element => nodeOf(element.id))) {
                for (const element of elements) { if (paint.restyle) restyleNode(element); else refreshNode(element); }
                renderOverlay(); positionMini();
            } else if (page === currentPage()) renderStage();
            scheduleThumbs(page?.id);
        } else { renderStage(); scheduleThumbs(); }
        return Promise.resolve();
    }
    const findIn = (value, id) => {
        for (const page of value?.pages || []) { const element = page.elements.find(item => item.id === id); if (element) return element; }
        return null;
    };
    const findElement = id => findIn(doc, id);
    const pageOf = id => doc?.pages.find(page => page.elements.some(item => item.id === id)) || null;
    const edit = (id, mutate, options = {}) => change(value => { const element = findIn(value, id); if (element) mutate(element); },
        {reflow: findElement(id)?.kind === 'body', paint: {element: id}, ...options});
    function restore(value) {
        doc = JSON.parse(value); lastKey = ''; cropping = null;
        const page = currentPage();
        picks = picks.filter(id => page?.elements.some(item => item.id === id)); selected = picks.at(-1) ?? null;
        changed({keepName: true}); void relayout().then(() => { renderPanel(); renderMini(); renderLayers(); });
    }
    function undo() { if (!history.length || exportJob) return; commitEditing(); future.push(snapshot()); const value = history.pop(); restore(value); }
    function redo() { if (!future.length || exportJob) return; commitEditing(); history.push(snapshot()); restore(future.pop()); }
    function scheduleSave() {
        clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 600);
        clearTimeout(lastTimer); lastTimer = setTimeout(flushLast, 2500);
    }
    function flushSave() {
        clearTimeout(saveTimer); saveTimer = null;
        if (!doc || !content || !store) return;
        void store.saveDraft(content.key, {stamp: content.stamp, doc: structuredClone(doc)}).catch(error => { console.warn('[千幕] 书摘成图稿未保存', error); setStatus('成图稿未能存到本机'); });
    }
    // 「上次的设置」：下次打开别的收藏时照这份版式起稿。
    function flushLast() {
        clearTimeout(lastTimer); lastTimer = null;
        if (!doc || !dirtyLast) return;
        dirtyLast = false;
        writeSettings(state => { state[content?.scope === 'reader' ? 'lastReader' : 'last'] = schemeFromDoc(doc); });
    }
    function updateTop() {
        undoButton.disabled = !history.length || !!exportJob; redoButton.disabled = !future.length || !!exportJob;
        const busy = !!exportJob;
        if (exportShown === busy) return;
        exportShown = busy;
        const label = busy ? '停止导出' : '导出图片';
        exportButton.title = label; exportButton.setAttribute('aria-label', label);
        exportButton.querySelector('.qm-xs-icon').replaceWith(icon(busy ? 'stop' : 'download'));
        dialog.classList.toggle('is-busy', busy);
    }

    // ── 字体与图片 ────────────────────────────────────────────────────────
    function fontIds() {
        const ids = new Set();
        for (const layoutItem of [...doc.pages, doc.restLayout]) for (const element of layoutItem.elements) {
            const font = element.props?.font;
            if (font && !FONT_STACKS[font]) ids.add(font);
        }
        return ids;
    }
    async function ensureFonts() {
        if (!fontProvider) return;
        const pending = [...fontIds()].filter(id => !families.has(id) && !fontFailed.has(id));
        await Promise.all(pending.map(async id => {
            let family = null;
            try { family = await fontProvider.family(id); } catch { family = null; }
            if (family) { families.set(id, family); return; }
            fontFailed.add(id);
            setStatus(`${fontList.find(font => font.id === id)?.name || '所选字体'}在这台设备上不可用`);
        }));
    }
    async function ensureImages() {
        const ids = imageIdsOf(doc).filter(id => !imageUrls.has(id));
        await Promise.all(ids.map(async id => {
            try { const record = await store.getImage(id); imageUrls.set(id, record?.blob ? URL.createObjectURL(record.blob) : ''); }
            catch { imageUrls.set(id, ''); }
        }));
    }
    const grainTile = (paper, size) => grainTiles.get(paper, size);
    const editorContext = () => ({families, imageSrc: id => imageUrls.get(id) || '', grainTile});
    // ── 排版与画面 ────────────────────────────────────────────────────────
    function measurerFor(value) {
        const css = value.template.css;
        if (measurer && measurerCss === css) return;
        measurer?.dispose(); measurer = createMeasurer(document, css); measurerCss = css;
    }
    async function relayout() {
        if (!doc) return;
        const token = ++relayoutToken;
        await Promise.all([ensureFonts(), ensureImages()]);
        if (token !== relayoutToken || !doc) return;
        measurerFor(doc);
        try {
            // 字体刚注册时可能还在解码：等它就绪再量，免得按后备字体分页。
            await document.fonts?.ready;
            if (token !== relayoutToken || !doc) return;
            layout = layoutDoc(doc, {measurer, ctx: editorContext(), makePage: () => makeContinuationPage(doc), hints: layoutHints});
        } catch (error) { console.warn('[千幕] 书摘排版失败', error); setStatus('排版失败，请重试'); }
        pageIndex = clamp(pageIndex, 0, doc.pages.length - 1);
        renderStage(); scheduleThumbs();
    }
    const currentPage = () => doc?.pages[pageIndex] || null;
    const layoutFor = page => layout.pages.find(item => item.id === page?.id) || {h: pageHeight(doc), slices: {}, breakBefore: -1};
    const currentLayout = () => layoutFor(currentPage());
    function nodeOf(id) { return pageNode?.querySelector(`[data-id="${CSS.escape(id)}"]`) || null; }
    function renderStage() {
        if (!doc) return;
        const page = currentPage(), info = currentLayout();
        const pruned = picks.length > 0 && !picks.every(id => page?.elements.some(item => item.id === id));
        if (pruned) { picks = picks.filter(id => page?.elements.some(item => item.id === id)); selected = picks.at(-1) ?? null; }
        const style = make('style'); style.textContent = `${BASE_CSS}\n${doc.template.css}\n${EDITOR_CSS}`;
        pageNode = buildPage(document, doc, page, info, editorContext());
        shadow.replaceChildren(style, pageNode);
        pageH = info.h;
        canvas.style.height = overlay.style.height = `${pageH}px`;
        if (cropping) nodeOf(cropping)?.classList.add('qm-cropping');
        fit(); renderOverlay(); renderMini(); renderLayers();
        if (pruned) renderPanel();
        if (preview) renderPreview();
    }
    // 纸色、文字色、杂色、背景透明度：只改页面根节点与杂色层，不重建整页。
    function paintPaper() {
        if (!pageNode) { renderStage(); return; }
        pageNode.setAttribute('style', pageStyle(doc, pageH));
        const old = pageNode.querySelector(':scope > .qm-grain'), next = buildGrain(document, doc, editorContext());
        if (old && next) old.setAttribute('style', next.getAttribute('style'));
        else if (old) old.remove();
        else if (next) { const bg = pageNode.querySelector(':scope > .qm-bg'); if (bg) bg.after(next); else pageNode.prepend(next); }
        const bg = pageNode.querySelector(':scope > .qm-bg');
        if (bg) bg.style.opacity = String(doc.bg.opacity ?? 1);
    }
    function fit() {
        if (!doc) return;
        const width = stage.clientWidth - 40, height = stage.clientHeight - 40;
        if (width <= 0 || height <= 0) return;
        // 长图按宽度铺开再上下滚动；一般页面整页放进窗口。
        const tall = pageH / PAGE_WIDTH > 2.4;
        scale = clamp(zoom || Math.min(width / PAGE_WIDTH, tall ? Infinity : height / pageH), 0.06, 3);
        canvas.style.transform = `scale(${scale})`;
        sheet.style.width = `${PAGE_WIDTH * scale}px`; sheet.style.height = `${pageH * scale}px`;
        sheet.style.setProperty('--s', String(scale));
        sheetOffset = null;
        positionMini();
    }
    function zoomBy(factor) { zoom = clamp((zoom || scale) * factor, 0.08, 3); fit(); }
    const renderedBox = element => ({x: element.x, y: element.y, w: element.w, h: element.h});
    // 选框、手柄与参考线的节点重复使用：拖动时只改位置，不反复增删（增删节点会惊动宿主页对整页的监听）。
    function overlayNode(key, className) {
        let node = overlayNodes.get(key);
        if (!node) { node = make('div', className); overlayNodes.set(key, node); }
        else if (node.className !== className) node.className = className;
        return node;
    }
    function handleNode(name, x, y) {
        const node = overlayNode(`h:${name}`, `qm-xs-handle is-${name}`);
        node.dataset.handle = name; node.style.left = `${x}px`; node.style.top = `${y}px`;
        return node;
    }
    const pickedElements = () => picks.map(findElement).filter(Boolean);
    const isMulti = () => picks.length > 1;
    const posLocked = element => element?.lock?.pos === true;
    const styleLocked = element => element?.lock?.style === true;
    // 一组框的外接矩形。
    function boundsOf(elements) {
        if (!elements.length) return null;
        let left = Infinity, topAt = Infinity, right = -Infinity, bottom = -Infinity;
        for (const element of elements) {
            const box = renderedBox(element);
            left = Math.min(left, box.x); topAt = Math.min(topAt, box.y); right = Math.max(right, box.x + box.w); bottom = Math.max(bottom, box.y + box.h);
        }
        return {x: left, y: topAt, w: right - left, h: bottom - topAt};
    }
    const selectionBox = () => boundsOf(pickedElements());
    const frameStyle = box => `left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px`;
    const HANDLE_SPOTS = {nw: [0, 0], n: [.5, 0], ne: [1, 0], e: [1, .5], se: [1, 1], s: [.5, 1], sw: [0, 1], w: [0, .5]};
    function overlayParts() {
        const parts = guides.map((guide, index) => {
            const line = overlayNode(`g:${index}`, `qm-xs-guide is-${guide.axis}`);
            line.style.left = guide.axis === 'x' ? `${guide.at}px` : ''; line.style.top = guide.axis === 'x' ? '' : `${guide.at}px`;
            return line;
        });
        const elements = pickedElements();
        if (!elements.length || pageOf(elements[0].id) !== currentPage()) return parts;
        if (elements.length > 1) {
            // 多选：每个元素一个细框，可移动的那几个外面一个组框带八个手柄（整组缩放）。
            for (const element of elements) {
                const frame = overlayNode(`m:${element.id}`, `qm-xs-sel is-member${posLocked(element) ? ' is-locked' : ''}${element.hidden ? ' is-hidden' : ''}`);
                frame.style.cssText = frameStyle(renderedBox(element));
                parts.push(frame);
            }
            const movable = elements.filter(element => !posLocked(element)), box = boundsOf(movable);
            if (!box || editing) return parts;
            const group = overlayNode('group', 'qm-xs-sel is-group');
            group.style.cssText = frameStyle(box);
            parts.push(group);
            for (const [name, [fx, fy]] of Object.entries(HANDLE_SPOTS)) parts.push(handleNode(name, box.x + box.w * fx, box.y + box.h * fy));
            return parts;
        }
        const element = elements[0], box = renderedBox(element), locked = posLocked(element);
        if (element.kind === 'line' && !locked && !element.hidden) {
            const [y1, y2] = element.dir === -1 ? [box.y + box.h, box.y] : [box.y, box.y + box.h];
            if (!editing) parts.push(handleNode('a', box.x, y1), handleNode('b', box.x + box.w, y2));
            return parts;
        }
        const frame = overlayNode('sel', `qm-xs-sel${locked ? ' is-locked' : ''}${element.hidden ? ' is-hidden' : ''}`);
        frame.style.cssText = frameStyle(box);
        parts.push(frame);
        if (editing || cropping || locked) return parts;
        for (const [name, [fx, fy]] of Object.entries(HANDLE_SPOTS)) parts.push(handleNode(name, box.x + box.w * fx, box.y + box.h * fy));
        return parts;
    }
    function renderOverlay() {
        const parts = overlayParts(), now = overlay.children;
        if (parts.length !== now.length || parts.some((node, index) => now[index] !== node)) {
            overlay.replaceChildren(...parts);
            // 多选的细框按元素记着，用不上的丢掉。
            const used = new Set(parts);
            for (const [key, node] of overlayNodes) if (key.startsWith('m:') && !used.has(node)) overlayNodes.delete(key);
        }
    }
    // 选中元素上方的小工具条（不随页面缩放）。
    function renderMini() {
        const element = selected && findElement(selected);
        const multi = isMulti();
        const key = element && !exportJob && pageOf(selected) === currentPage()
            ? multi ? `multi|${picks.length}` : [element.id, element.kind, !!element.image, editing?.id, cropping].join('|') : '';
        // 工具条内容只随选中、编辑、裁切变；没变时只挪位置。
        if (key === miniKey && (key ? !mini.hidden : mini.hidden)) { positionMini(); return; }
        miniKey = key; miniSize = null;
        mini.replaceChildren();
        if (!key) { mini.hidden = true; return; }
        const items = [];
        if (multi) {
            items.push(button('层级', 'layers', event => openLayerMenu(event.currentTarget)), button('复制', 'copy', duplicate), button('删除', 'trash', removeSelected));
        } else if (editing) {
            if (element.kind === 'body') items.push(button('在此分页', 'breakpage', insertBreak, {keepFocus: true, text: '分页'}));
            items.push(button('完成', 'check', () => commitEditing(), {keepFocus: true}));
        } else {
            if (EDITABLE.has(element.kind)) items.push(button('编辑文字', 'edit', () => startEdit(element.id)));
            if (element.kind === 'dialog') items.push(button('选择对话', 'talk', event => openDialoguePicker(event.currentTarget, element.id)));
            if (element.kind === 'image') {
                items.push(button(element.image ? '换图' : '选图', 'image', () => pickImage(element.id)));
                if (element.image) items.push(button(cropping ? '完成裁切' : '裁切', cropping ? 'check' : 'crop', () => toggleCrop(element.id)));
            }
            items.push(button('层级', 'layers', event => openLayerMenu(event.currentTarget)), button('复制', 'copy', duplicate), button('删除', 'trash', removeSelected));
        }
        mini.append(...items); mini.hidden = false;
        positionMini();
    }
    // 工具条尺寸与画纸位置记一次，拖动时不再每步强制浏览器重新排版去读。
    function positionMini() {
        const box = !mini.hidden && selectionBox();
        if (!box) return;
        miniSize ??= {width: mini.offsetWidth || 160, height: mini.offsetHeight || 36};
        sheetOffset ??= {left: sheet.offsetLeft, top: sheet.offsetTop};
        const {width, height} = miniSize, sheetWidth = PAGE_WIDTH * scale;
        let left = (box.x + box.w / 2) * scale - width / 2, topAt = box.y * scale - height - 10;
        if (topAt < -sheetOffset.top + 4) topAt = (box.y + box.h) * scale + 10;
        left = clamp(left, -sheetOffset.left + 4, Math.max(4, sheetWidth + sheetOffset.left - width - 4));
        mini.style.left = `${left}px`; mini.style.top = `${topAt}px`;
    }
    // ── 拖动、缩放、端点、取景 ────────────────────────────────────────────
    function point(event) { const rect = canvas.getBoundingClientRect(); return {x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale}; }
    function hit(event) {
        for (const node of event.composedPath()) {
            if (node === pageNode || node === canvas) break;
            if (node?.classList?.contains?.('qm-el') && node.dataset?.id) return node.dataset.id;
        }
        return null;
    }
    // 换选中：ids 只留当前页上的；与原来一样就什么都不做。
    function setPicks(ids) {
        const page = currentPage();
        const next = [...new Set(ids)].filter(id => id && page?.elements.some(item => item.id === id));
        if (next.length === picks.length && next.every((id, index) => picks[index] === id)) return;
        if (cropping && !(next.length === 1 && next[0] === cropping)) { const was = cropping; cropping = null; nodeOf(was)?.classList.remove('qm-cropping'); }
        picks = next; selected = next.at(-1) ?? null;
        renderOverlay(); renderMini(); renderPanel(); renderLayers();
    }
    function select(id) { setPicks(id ? [id] : []); }
    function togglePick(id) { setPicks(picks.includes(id) ? picks.filter(item => item !== id) : [...picks, id]); }
    function setTool(next) {
        tool = next === 'multi' ? 'multi' : 'select';
        selectTool.setAttribute('aria-pressed', String(tool === 'select')); multiTool.setAttribute('aria-pressed', String(tool === 'multi'));
        dialog.classList.toggle('is-multi', tool === 'multi');
    }
    // 吸附：box 是正在拖的框（或一组框的外接矩形），对齐页面中线、边缘与其余可见元素的边。
    function snapMove(box, x, y, exclude) {
        const page = currentPage(), threshold = 7 / scale;
        const xs = [0, PAGE_WIDTH / 2, PAGE_WIDTH], ys = [0, pageH / 2, pageH];
        for (const other of page.elements) {
            if (exclude.has(other.id) || other.hidden) continue;
            const b = renderedBox(other);
            xs.push(b.x, b.x + b.w / 2, b.x + b.w); ys.push(b.y, b.y + b.h / 2, b.y + b.h);
        }
        guides = [];
        const best = (edges, targets) => {
            let found = null;
            for (const edge of edges) for (const target of targets) {
                const distance = target - edge;
                if (Math.abs(distance) <= threshold && (!found || Math.abs(distance) < Math.abs(found.distance))) found = {distance, target};
            }
            return found;
        };
        const sx = best([x, x + box.w / 2, x + box.w], xs), sy = best([y, y + box.h / 2, y + box.h], ys);
        if (sx) { x += sx.distance; guides.push({axis: 'x', at: sx.target}); }
        if (sy) { y += sy.distance; guides.push({axis: 'y', at: sy.target}); }
        return {x, y};
    }
    function resizeTo(element, o, handle, dx, dy, keepRatio) {
        let {x, y, w, h} = o;
        if (handle.includes('e')) w = o.w + dx;
        if (handle.includes('s')) h = o.h + dy;
        if (handle.includes('w')) { w = o.w - dx; x = o.x + dx; }
        if (handle.includes('n')) { h = o.h - dy; y = o.y + dy; }
        const min = 12;
        if (w < min) { if (handle.includes('w')) x = o.x + o.w - min; w = min; }
        if (h < min) { if (handle.includes('n')) y = o.y + o.h - min; h = min; }
        if (keepRatio && handle.length === 2 && o.h > 0) {
            const ratio = o.w / o.h;
            if (w / h > ratio) w = h * ratio; else h = w / ratio;
            if (handle.includes('w')) x = o.x + o.w - w;
            if (handle.includes('n')) y = o.y + o.h - h;
        }
        Object.assign(element, {x: round(x), y: round(y), w: round(w), h: round(h)});
    }
    function lineEnds(element) {
        return element.dir === -1 ? [{x: element.x, y: element.y + element.h}, {x: element.x + element.w, y: element.y}]
            : [{x: element.x, y: element.y}, {x: element.x + element.w, y: element.y + element.h}];
    }
    function lineTo(element, o, handle, p, snapAngle) {
        const offset = renderedBox(o).y - o.y, [a, b] = lineEnds(o), fixed = handle === 'a' ? b : a;
        let q = {x: p.x, y: p.y - offset};
        const dx = q.x - fixed.x, dy = q.y - fixed.y, length = Math.hypot(dx, dy);
        if (snapAngle && length) {
            const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            q = {x: fixed.x + Math.cos(angle) * length, y: fixed.y + Math.sin(angle) * length};
        } else if (Math.abs(dy) < 8 / scale) q.y = fixed.y;
        else if (Math.abs(dx) < 8 / scale) q.x = fixed.x;
        const [p1, p2] = handle === 'a' ? [q, fixed] : [fixed, q];
        element.x = round(Math.min(p1.x, p2.x)); element.y = round(Math.min(p1.y, p2.y));
        element.w = round(Math.abs(p2.x - p1.x)); element.h = round(Math.abs(p2.y - p1.y));
        element.dir = (p2.x - p1.x) * (p2.y - p1.y) < 0 ? -1 : 1;
    }
    function panTo(element, o, dx, dy) {
        const frameH = o.h;
        const before = imageGeometry(o.w, frameH, o.image);
        element.image.cx = clamp(o.image.cx - dx / before.w, 0, 1); element.image.cy = clamp(o.image.cy - dy / before.h, 0, 1);
        const after = imageGeometry(o.w, frameH, element.image);
        element.image.cx = round((o.w / 2 - after.left) / after.w * 1000) / 1000;
        element.image.cy = round((frameH / 2 - after.top) / after.h * 1000) / 1000;
    }
    function refreshNode(element) {
        const node = nodeOf(element.id), page = currentPage();
        if (!node || !page) return;
        const next = buildElement(document, doc, page, element, currentLayout(), editorContext(), page.elements.indexOf(element) + 1);
        if (cropping === element.id) next.classList.add('qm-cropping');
        node.replaceWith(next);
    }
    // 只改样式、不动内容时（字号、颜色、透明度、混合……）：换掉框的行内样式即可，不重建框里的字。
    function restyleNode(element) {
        const node = nodeOf(element.id), page = currentPage();
        if (!node || !page) return;
        node.setAttribute('style', elementCss(element, {families, z: page.elements.indexOf(element) + 1}));
    }
    // 整组缩放：各元素在组框里的相对位置与大小按组框的伸缩换算（字号不变，与单个框缩放一样）。
    function scaleGroup(origs, from, to) {
        const sx = from.w > 0 ? to.w / from.w : 1, sy = from.h > 0 ? to.h / from.h : 1;
        for (const [id, o] of origs) {
            const element = findElement(id);
            if (!element) continue;
            const min = element.kind === 'line' ? 0 : 4;
            element.x = round(to.x + (o.x - from.x) * sx); element.y = round(to.y + (o.y - from.y) * sy);
            element.w = round(Math.max(min, o.w * sx)); element.h = round(Math.max(min, o.h * sy));
        }
    }
    const touchScroll = event => ({type: 'scroll', sx: event.clientX, sy: event.clientY, left: stage.scrollLeft, top: stage.scrollTop, pointer: event.pointerId});
    canvas.addEventListener('pointerdown', event => {
        if (!doc || event.button > 0 || exportJob) return;
        closePop();
        const handle = event.target.closest?.('[data-handle]');
        const additive = event.shiftKey || event.ctrlKey || event.metaKey || tool === 'multi';
        const id = handle ? selected : hit(event);
        if (editing) {
            if (id === editing.id && !handle) return;      // 编辑中的框里点按交给浏览器放光标
            commitEditing();
        }
        const capture = () => { try { canvas.setPointerCapture(event.pointerId); } catch { /* 指针已结束 */ } };
        if (!id) {
            if (cropping) toggleCrop(cropping);
            if (!additive) select(null);
            // 触屏在空白处拖动等于滚动画面（画布关掉了浏览器自带的触摸滚动）。
            drag = event.pointerType === 'touch' ? touchScroll(event) : null;
            if (drag) capture();
            return;
        }
        const element = findElement(id);
        if (!element) return;
        const wasSelected = picks.length === 1 && selected === id;
        if (handle && isMulti()) {
            const movable = pickedElements().filter(item => !posLocked(item));
            drag = {type: 'group', handle: handle.dataset.handle, start: point(event), box: boundsOf(movable), origs: new Map(movable.map(item => [item.id, renderedBox(item)])),
                before: snapshot(), moved: false, pointer: event.pointerId};
            capture(); event.preventDefault();
            return;
        }
        if (!handle) {
            if (additive) {
                // 多选点到已选的就从组里去掉（不拖），点到没选的就加进来，可以接着拖整组。
                const had = picks.includes(id);
                togglePick(id);
                if (had) { event.preventDefault(); return; }
            } else if (!picks.includes(id)) select(id);
        }
        if (!handle && cropping === id) {
            drag = {type: 'pan', id, start: point(event), orig: structuredClone(element), before: snapshot(), moved: false, wasSelected, pointer: event.pointerId};
        } else if (handle) {
            drag = {type: element.kind === 'line' ? 'line' : 'resize', id, handle: handle.dataset.handle, start: point(event), orig: structuredClone(element),
                before: snapshot(), moved: false, wasSelected, pointer: event.pointerId};
        } else {
            // 拖动：选中的里面位置没锁的一起走；都锁住时触屏上当作滚动画面。
            const movable = pickedElements().filter(item => !posLocked(item));
            drag = movable.length ? {type: 'move', id, start: point(event), box: boundsOf(movable), origs: new Map(movable.map(item => [item.id, {x: item.x, y: item.y}])),
                exclude: new Set(picks), before: snapshot(), moved: false, wasSelected, additive, pointer: event.pointerId}
                : event.pointerType === 'touch' ? touchScroll(event) : {type: 'click', id, start: point(event), moved: false, wasSelected, additive, pointer: event.pointerId};
        }
        capture();
        event.preventDefault();
    });
    canvas.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointer) return;
        if (drag.type === 'scroll') { stage.scrollLeft = drag.left - (event.clientX - drag.sx); stage.scrollTop = drag.top - (event.clientY - drag.sy); return; }
        const p = point(event), dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        if (!drag.moved && Math.hypot(dx * scale, dy * scale) < 4) return;
        if (drag.type === 'click') return;
        drag.moved = true;
        if (drag.type === 'move') {
            const box = drag.box, snapped = snapMove(box, box.x + dx, box.y + dy, drag.exclude);
            const mx = snapped.x - box.x, my = snapped.y - box.y;
            // 只挪位置：改这几个框的 left/top，不重建（重建要重新排它里面的字）。
            for (const [id, o] of drag.origs) {
                const element = findElement(id);
                if (!element) continue;
                element.x = round(o.x + mx); element.y = round(o.y + my);
                const node = nodeOf(id);
                if (node) { node.style.left = `${element.x}px`; node.style.top = `${element.y}px`; }
            }
            renderOverlay(); positionMini();
            return;
        }
        if (drag.type === 'group') {
            const to = {...drag.box};
            resizeTo(to, drag.box, drag.handle, dx, dy, event.shiftKey);
            scaleGroup(drag.origs, drag.box, to);
            for (const id of drag.origs.keys()) { const element = findElement(id); if (element) refreshNode(element); }
            renderOverlay(); positionMini();
            return;
        }
        const element = findElement(drag.id);
        if (!element) return;
        const o = drag.orig;
        if (drag.type === 'resize') resizeTo(element, o, drag.handle, dx, dy, event.shiftKey || element.kind === 'image' && !!element.image && drag.handle.length === 2 && event.altKey);
        else if (drag.type === 'line') lineTo(element, o, drag.handle, p, event.shiftKey);
        else if (drag.type === 'pan') panTo(element, o, dx, dy);
        refreshNode(element); renderOverlay(); positionMini();
    });
    function endDrag(event, cancelled) {
        const state = drag;
        if (!state || event.pointerId !== state.pointer) return;
        drag = null; guides = [];
        try { canvas.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }
        if (state.type === 'scroll') return;
        if (cancelled && state.moved) { restore(state.before); return; }
        if (state.moved) {
            pushHistory(state.before); changed();
            // 改了正文框的大小才要重排；只是挪动不影响分页。
            const ids = state.origs ? [...state.origs.keys()] : [state.id];
            const resized = state.type !== 'move' && ids.some(id => findElement(id)?.kind === 'body');
            if (resized) void relayout(); else { renderOverlay(); positionMini(); scheduleThumbs(currentPage()?.id); }
            renderPanelGeometry();
            return;
        }
        renderOverlay();
        const element = state.id && findElement(state.id);
        if (!element || cancelled || state.type === 'group') return;
        // 在多选里点一下（没拖）其中一个：只留它。
        if (!state.additive && isMulti()) { select(element.id); return; }
        if (state.additive) return;
        if (element.kind === 'image' && !element.image) { pickImage(element.id); return; }
        if (state.wasSelected && EDITABLE.has(element.kind)) startEdit(element.id);
    }
    canvas.addEventListener('pointerup', event => endDrag(event, false));
    canvas.addEventListener('pointercancel', event => endDrag(event, true));
    canvas.addEventListener('dblclick', event => {
        const id = hit(event), element = id && findElement(id);
        if (!element || exportJob) return;
        if (EDITABLE.has(element.kind) && editing?.id !== id) startEdit(id);
        else if (element.kind === 'image' && element.image) toggleCrop(id);
    });
    canvas.addEventListener('wheel', event => {
        const element = cropping && findElement(cropping);
        if (element && hit(event) === cropping) {
            event.preventDefault();
            remember(`${cropping}:zoom`);
            element.image.zoom = round(clamp(element.image.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08), 1, 8));
            refreshNode(element); changed(); renderPanel();
        } else if (event.ctrlKey || event.metaKey) { event.preventDefault(); zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1); }
    }, {passive: false});
    stage.addEventListener('pointerdown', event => {
        if (event.target !== stage && event.target !== sheet) return;
        commitEditing(); closePop();
        if (cropping) toggleCrop(cropping);
        if (tool !== 'multi' && !event.shiftKey) select(null);
    });
    stage.addEventListener('scroll', () => { sheetOffset = null; positionMini(); }, {passive: true});
    let fitFrame = 0;
    const resizeObserver = view?.ResizeObserver ? new view.ResizeObserver(() => { cancelAnimationFrame(fitFrame); fitFrame = requestAnimationFrame(() => fit()); }) : null;
    resizeObserver?.observe(stage);

    // 关闭请求（Esc、手机返回手势）不直接关掉排版台；开着预览时先退出预览。
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (preview) closePreview(); });
    dialog.addEventListener('keydown', event => {
        event.stopPropagation();
        if (!visible || !doc) return;
        if (preview) {
            if (event.key === 'Escape') { event.preventDefault(); closePreview(); }
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); turnPreview(event.key === 'ArrowLeft' ? -1 : 1); }
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            if (!pop.hidden) closePop();
            else if (!editor.hidden) editor.hidden = true;
            else if (editing) commitEditing();
            else if (cropping) toggleCrop(cropping);
            else if (selected) select(null);
            else close();
            return;
        }
        if (editing || !editor.hidden || event.target?.matches?.('input, textarea, select')) return;
        const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
        if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
        if (mod && key === 'y') { event.preventDefault(); redo(); return; }
        if (mod && key === 'a' && !exportJob) { event.preventDefault(); setPicks(currentPage()?.elements.map(item => item.id) || []); return; }
        const element = selected && findElement(selected);
        if (!element || exportJob) return;
        if (key === 'delete' || key === 'backspace') { event.preventDefault(); removeSelected(); }
        else if (mod && key === 'd') { event.preventDefault(); duplicate(); }
        else if (key === 'enter' && EDITABLE.has(element.kind) && !isMulti()) { event.preventDefault(); startEdit(element.id); }
        else if (key.startsWith('arrow')) {
            event.preventDefault();
            const step = event.shiftKey ? 10 : 1, ids = pickedElements().filter(item => !posLocked(item)).map(item => item.id);
            if (!ids.length) return;
            const [mx, my] = {arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step]}[key];
            change(value => { for (const id of ids) { const item = findIn(value, id); if (item) { item.x = round(item.x + mx); item.y = round(item.y + my); } } },
                {key: `${ids.join(',')}:nudge`, reflow: false, paint: {elements: ids, restyle: true}});
            renderPanelGeometry();
        }
    });
    // ── 就地改字 ──────────────────────────────────────────────────────────
    const selectionFor = () => shadow.getSelection?.() || view.getSelection?.() || null;
    function readEditable(node) {
        const lines = [], blocks = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'SECTION']);
        let line = '', started = false;
        const walk = parent => {
            for (const child of parent.childNodes) {
                if (child.nodeType === 3) { line += child.nodeValue; started = true; }
                else if (child.nodeName === 'BR') {
                    if (child.parentNode !== node && child.parentNode.childNodes.length === 1) continue;  // 空段落里占位的 <br>
                    lines.push(line); line = ''; started = true;
                } else if (blocks.has(child.nodeName)) {
                    if (started) { lines.push(line); line = ''; }
                    walk(child); started = true;
                } else walk(child);
            }
        };
        walk(node); lines.push(line);
        return lines.join('\n').replace(/​/g, '');
    }
    // 就地改对话后读回：每句按原来的序号对回，删掉的句子就不在了。
    function dialogTexts(node) {
        return [...node.querySelectorAll('.qm-say')].map(say => ({index: Number(say.dataset.index), text: (say.querySelector('.qm-line')?.textContent || say.textContent.replace(say.querySelector('.qm-who')?.textContent || '', '')).replace(/\u200b/g, '')}))
            .filter(item => Number.isInteger(item.index));
    }
    function insertText(text) {
        let done = false;
        try { done = document.execCommand?.('insertText', false, text) === true; } catch { done = false; }
        if (done) return;
        const selection = selectionFor();
        if (!selection?.rangeCount) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node); range.setStartAfter(node); range.collapse(true);
        selection.removeAllRanges(); selection.addRange(range);
    }
    const onEditPaste = event => { event.preventDefault(); insertText((event.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n')); };
    const onEditBeforeInput = event => { if (/^format/.test(event.inputType || '')) event.preventDefault(); };
    const onEditBlur = event => { if (editing && !(event.relatedTarget && editing.node.contains(event.relatedTarget))) commitEditing(); };
    function startEdit(id) {
        const element = findElement(id);
        if (!element || !EDITABLE.has(element.kind) || element.hidden || exportJob) return;
        if (editing) commitEditing();
        if (pageOf(id) !== currentPage()) return;
        if (picks.length !== 1 || selected !== id) select(id);
        const node = nodeOf(id);
        if (!node) return;
        const slice = element.kind === 'body' ? currentLayout().slices[id] || {start: doc.body.length, end: doc.body.length} : null;
        const readLines = element.kind === 'dialog' ? () => JSON.stringify(dialogTexts(node)) : null;
        editing = {id, kind: element.kind, node, slice, before: snapshot(), original: slice ? doc.body.slice(slice.start, slice.end) : readLines ? readLines() : element.text};
        // 对话里名字不可改，只改每一句的话。
        if (element.kind === 'dialog') for (const who of node.querySelectorAll('.qm-who')) who.setAttribute('contenteditable', 'false');
        if (slice && slice.end <= slice.start) fillParagraphs(document, node, [''], false);
        node.setAttribute('contenteditable', 'true'); node.spellcheck = false;
        node.classList.add('qm-editing');
        node.addEventListener('focusout', onEditBlur); node.addEventListener('paste', onEditPaste); node.addEventListener('beforeinput', onEditBeforeInput);
        node.focus({preventScroll: true});
        const selection = selectionFor();
        if (selection) {
            const range = document.createRange(); range.selectNodeContents(node);
            if (element.kind === 'body') range.collapse(false);
            try { selection.removeAllRanges(); selection.addRange(range); } catch { /* 选区放不进影子根时，光标交给用户点选 */ }
        }
        renderOverlay(); renderMini();
    }
    function commitEditing() {
        if (!editing) return;
        const state = editing; editing = null;
        const {node} = state;
        node.removeEventListener('focusout', onEditBlur); node.removeEventListener('paste', onEditPaste); node.removeEventListener('beforeinput', onEditBeforeInput);
        node.removeAttribute('contenteditable'); node.classList.remove('qm-editing');
        const text = state.kind === 'dialog' ? JSON.stringify(dialogTexts(node)) : readEditable(node), element = findElement(state.id);
        if (element && text !== state.original) {
            pushHistory(state.before);
            if (state.kind === 'text') { element.text = text.slice(0, 5000); element.src = null; }
            else if (state.kind === 'dialog') {
                const kept = dialogTexts(node);
                element.lines = kept.map(({index, text: words}) => ({...element.lines[index], text: words})).filter(line => line.who && line.text.trim());
            } else {
                const {start, end} = state.slice;
                doc.body = `${doc.body.slice(0, start)}${text}${doc.body.slice(end)}`.replace(/\n*\f\n*/g, PAGE_BREAK).replace(/\f{2,}/g, PAGE_BREAK);
            }
            changed({keepName: true});
        }
        void relayout();
        renderMini();
    }
    function insertBreak() { if (editing?.kind !== 'body') return; insertText(PAGE_BREAK); commitEditing(); }
    function removeBreak(at) { if (doc?.body[at] === PAGE_BREAK) change(value => { value.body = `${value.body.slice(0, at)}\n${value.body.slice(at + 1)}`; }, {keepName: true}); }

    // ── 元素与页面操作 ────────────────────────────────────────────────────
    const DEFAULTS = {
        text: {w: 520, h: 80, text: '文字', props: {size: 40}},
        image: {w: 520, h: 380},
        line: {w: 420, h: 0, props: {strokeWidth: 2}},
        rect: {w: 340, h: 220},
        ellipse: {w: 280, h: 280},
        dialog: {w: 760, h: 260, props: {size: 26}},
    };
    function addElement(kind) {
        if (!doc || exportJob) return;
        commitEditing();
        const page = currentPage(), base = DEFAULTS[kind];
        const visibleTop = stage.scrollTop / scale, visibleH = Math.min(pageH, stage.clientHeight / scale);
        const element = normalizeElement({kind, ...structuredClone(base), src: null, x: (PAGE_WIDTH - base.w) / 2, y: clamp(visibleTop + (visibleH - base.h) / 2, 0, pageH - base.h),
            ...(kind === 'dialog' ? {lines: content?.lines?.length ? content.lines : (content?.dialogue?.messages || []).slice(-4)} : {})}, pageH);
        if (kind === 'line') element.h = 0;
        change(() => { page.elements.push(element); }, {reflow: false});
        select(element.id);
        if (kind === 'text') startEdit(element.id);
    }
    // 清空选中而不重画（随后的 change 会整页重画）。
    function dropPicks() { picks = []; selected = null; cropping = null; }
    function removeSelected() {
        const page = currentPage(), ids = new Set(picks);
        if (!page || !ids.size) return;
        commitEditing();
        const reflow = pickedElements().some(item => item.kind === 'body');
        dropPicks();
        change(() => { page.elements = page.elements.filter(item => !ids.has(item.id)); }, {reflow});
        renderPanel(); renderMini(); renderLayers();
    }
    function duplicate() {
        const page = currentPage(), elements = pickedElements();
        if (!page || !elements.length) return;
        commitEditing();
        let flow = Math.max(-1, ...page.elements.filter(item => item.kind === 'body').map(item => item.flow));
        const copies = elements.map(element => {
            const copy = {...structuredClone(element), id: newId(), x: element.x + 24, y: element.y + 24};
            if (copy.kind === 'body') copy.flow = ++flow;
            return [element, copy];
        });
        // 按页面上的先后插回去，每个副本紧跟在原件上面一层。
        copies.sort((a, b) => page.elements.indexOf(b[0]) - page.elements.indexOf(a[0]));
        change(() => { for (const [element, copy] of copies) page.elements.splice(page.elements.indexOf(element) + 1, 0, copy); },
            {reflow: copies.some(([, copy]) => copy.kind === 'body')});
        setPicks(copies.reverse().map(([, copy]) => copy.id));
    }
    // 层级：多选时各自上移／下移一层（相对次序不变），置顶／置底整组一起。
    function arrangeList(list, ids, where) {
        const chosen = list.filter(item => ids.has(item.id));
        if (!chosen.length) return false;
        const before = list.map(item => item.id).join();
        if (where === 'top' || where === 'bottom') {
            const rest = list.filter(item => !ids.has(item.id));
            list.splice(0, list.length, ...(where === 'top' ? [...rest, ...chosen] : [...chosen, ...rest]));
        } else if (where === 'up') {
            for (let index = list.length - 2; index >= 0; index--) if (ids.has(list[index].id) && !ids.has(list[index + 1].id)) [list[index], list[index + 1]] = [list[index + 1], list[index]];
        } else {
            for (let index = 1; index < list.length; index++) if (ids.has(list[index].id) && !ids.has(list[index - 1].id)) [list[index], list[index - 1]] = [list[index - 1], list[index]];
        }
        return list.map(item => item.id).join() !== before;
    }
    function arrange(where) {
        const page = currentPage(), ids = new Set(picks);
        if (!page || !ids.size) return;
        const probe = [...page.elements];
        if (!arrangeList(probe, ids, where)) return;
        change(() => { arrangeList(page.elements, ids, where); }, {reflow: false});
    }
    function goPage(index) {
        if (!doc || index === pageIndex) return;
        commitEditing(); dropPicks();
        pageIndex = clamp(index, 0, doc.pages.length - 1);
        // 翻页不改页面设置：面板本来就是「页面」时不重建（滑杆控件重建很费）。
        stage.scrollTop = 0; renderStage(); markCurrentThumb();
        if (panelShows !== 'page') renderPanel();
    }
    function addPage() {
        if (!doc || doc.pages.length >= 60) return;
        commitEditing(); dropPicks();
        change(value => { const page = makeContinuationPage(value); page.auto = false; value.pages.splice(pageIndex + 1, 0, page); pageIndex++; });
        renderPanel();
    }
    function deletePage(index) {
        if (!doc || doc.pages.length <= 1) return;
        commitEditing(); dropPicks();
        change(value => { value.pages.splice(index, 1); pageIndex = clamp(pageIndex, 0, value.pages.length - 1); });
        renderPanel();
    }
    function toggleCrop(id) {
        const element = findElement(id);
        if (cropping === id || !element?.image) { const was = cropping; cropping = null; if (was) nodeOf(was)?.classList.remove('qm-cropping'); }
        else { commitEditing(); if (picks.length !== 1 || selected !== id) select(id); cropping = id; nodeOf(id)?.classList.add('qm-cropping'); }
        renderOverlay(); renderMini(); renderPanel();
    }
    // 图层开关：隐藏（正文框隐藏后字流到别的框）、锁位置、锁样式。都进撤销记录；锁不算改版式。
    function setLayerFlag(ids, flag, value) {
        const elements = ids.map(findElement).filter(Boolean);
        if (!elements.length) return;
        if (flag === 'hidden' && editing && ids.includes(editing.id)) commitEditing();
        if (flag === 'hidden' && cropping && ids.includes(cropping)) toggleCrop(cropping);
        const reflow = flag === 'hidden' && elements.some(item => item.kind === 'body');
        change(next => {
            for (const id of ids) {
                const item = findIn(next, id);
                if (!item) continue;
                if (flag === 'hidden') item.hidden = value; else item.lock = {...item.lock, [flag]: value};
            }
        }, {reflow, keepName: flag !== 'hidden', paint: {elements: elements.map(item => item.id)}}).then(() => { renderPanel(); renderMini(); renderLayers(); });
    }
    function pickImage(target) {
        if (exportJob) return;
        pickTarget = target; imageInput.value = ''; imageInput.click();
    }
    imageInput.addEventListener('change', async () => {
        const file = imageInput.files?.[0], target = pickTarget;
        pickTarget = null; imageInput.value = '';
        if (!file || !doc || !store) return;
        setStatus('正在读入图片…', true);
        try {
            const prepared = await prepareImage(file, {document});
            const id = newId('img');
            await store.putImage(id, prepared.blob, prepared.w, prepared.h);
            if (!doc) return;
            imageUrls.set(id, URL.createObjectURL(prepared.blob));
            if (target === 'bg') change(value => { value.bg = {...value.bg, image: id, w: prepared.w, h: prepared.h}; }, {reflow: false});
            else edit(target, element => { element.image = {id, w: prepared.w, h: prepared.h, cx: 0.5, cy: 0.5, zoom: 1}; }, {reflow: false});
            setStatus('');
            renderPanel(); renderMini();
        } catch (error) { setStatus(error?.message || '图片没能读入'); }
    });

    // ── 浮层：菜单、取色、询问 ────────────────────────────────────────────
    function openPop(anchor, content, onClose = null) {
        closePop();
        pop.replaceChildren(content); pop.hidden = false; popClose = onClose;
        const box = dialog.getBoundingClientRect(), rect = anchor.getBoundingClientRect();
        const width = pop.offsetWidth, height = pop.offsetHeight;
        let left = rect.left - box.left, topAt = rect.bottom - box.top + 6;
        left = clamp(left, 8, Math.max(8, box.width - width - 8));
        if (topAt + height > box.height - 8) topAt = Math.max(8, rect.top - box.top - height - 6);
        pop.style.left = `${left}px`; pop.style.top = `${topAt}px`;
    }
    function closePop() {
        if (pop.hidden) return;
        pop.hidden = true; pop.replaceChildren();
        const done = popClose; popClose = null; done?.();
    }
    dialog.addEventListener('pointerdown', event => {
        if (!pop.hidden && !pop.contains(event.target) && !event.target.closest?.('.qm-xs-color')) closePop();
    }, true);
    function menuRow(label, action, {current: isNow = false, extra = []} = {}) {
        const row = make('div', `qm-xs-menu-row${isNow ? ' is-current' : ''}`);
        const main = make('button', 'qm-xs-menu-main', label); main.type = 'button';
        main.addEventListener('click', action);
        row.append(main, ...extra);
        return row;
    }
    function openLayerMenu(anchor) {
        const list = make('div', 'qm-xs-menu');
        for (const [where, label, name] of [['top', '置于顶层', 'top'], ['up', '上移一层', 'up'], ['down', '下移一层', 'down'], ['bottom', '置于底层', 'bottom']]) {
            const row = menuRow(label, () => { closePop(); arrange(where); });
            row.querySelector('button').prepend(icon(name));
            list.append(row);
        }
        openPop(anchor, list);
    }
    function askText(anchor, title, value = '') {
        return new Promise(resolve => {
            const box = make('form', 'qm-xs-ask'), input = make('input');
            input.value = value; input.maxLength = 40;
            const row = make('div', 'qm-xs-ask-row');
            let settled = false;
            const finish = result => { if (settled) return; settled = true; resolve(result); closePop(); };
            row.append(textButton('取消', () => finish(null)), textButton('确定', () => finish(input.value.trim() || null), 'is-primary'));
            box.append(make('div', 'qm-xs-ask-title', title), input, row);
            box.addEventListener('submit', event => { event.preventDefault(); finish(input.value.trim() || null); });
            openPop(anchor, box, () => { if (!settled) { settled = true; resolve(null); } });
            input.focus(); input.select();
        });
    }
    function askConfirm(anchor, text, okLabel = '确定') {
        return new Promise(resolve => {
            const box = make('div', 'qm-xs-ask'), row = make('div', 'qm-xs-ask-row');
            let settled = false;
            const finish = result => { if (settled) return; settled = true; resolve(result); closePop(); };
            row.append(textButton('取消', () => finish(false)), textButton(okLabel, () => finish(true), 'is-danger'));
            box.append(make('div', 'qm-xs-ask-title', text), row);
            openPop(anchor, box, () => { if (!settled) { settled = true; resolve(false); } });
        });
    }
    // 取色盘：与千幕主题强调色同一种取法——饱和度明度面板＋色相条＋HEX，圆点显示当前所取的色。
    function openColorPicker(anchor, value, onValue, {allowNone = false} = {}) {
        let hex = normalizeHex(value, '#000000'), hsv = rgbHsv(hexRgb(hex)), picked = false;
        const box = make('div', 'qm-xs-picker');
        const sv = make('div', 'qm-xs-sv'), marker = make('i');
        sv.append(marker); sv.setAttribute('role', 'slider'); sv.setAttribute('aria-label', '饱和度与明度'); sv.tabIndex = 0;
        const hue = make('input', 'qm-xs-hue'); hue.type = 'range'; hue.min = '0'; hue.max = '360'; hue.step = '1'; hue.setAttribute('aria-label', '色相');
        const hexRow = make('div', 'qm-xs-hexrow'), dot = make('span', 'qm-xs-dot'), hexInput = make('input');
        hexInput.maxLength = 7; hexInput.spellcheck = false; hexInput.setAttribute('aria-label', 'HEX 色值');
        hexRow.append(dot, hexInput);
        const swatches = make('div', 'qm-xs-swatches');
        const palette = [...new Set([...recentColors, doc?.paper, doc?.ink, '#000000', '#ffffff', '#d8211e', '#b5322a', '#8b584a', '#527c69', '#5c79d3', '#7b65a7'].filter(Boolean))].slice(0, 16);
        if (allowNone) {
            const none = make('button', 'qm-xs-swatch is-none'); none.type = 'button'; none.title = '无'; none.setAttribute('aria-label', '无');
            none.addEventListener('click', () => { picked = true; onValue('none'); dot.classList.add('is-none'); });
            swatches.append(none);
        }
        for (const color of palette) {
            const swatch = make('button', 'qm-xs-swatch'); swatch.type = 'button'; swatch.title = color; swatch.style.background = color;
            swatch.addEventListener('click', () => { hex = color; hsv = rgbHsv(hexRgb(hex)); paint(true); });
            swatches.append(swatch);
        }
        box.append(sv, hue, hexRow, swatches);
        function paint(emit) {
            sv.style.backgroundImage = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${hsv.h} 100% 50%))`;
            marker.style.left = `${hsv.s * 100}%`; marker.style.top = `${(1 - hsv.v) * 100}%`;
            hue.value = String(Math.round(hsv.h));
            dot.style.background = hex; dot.classList.remove('is-none');
            if (document.activeElement !== hexInput) hexInput.value = hex;
            if (emit) { picked = true; onValue(hex); }
        }
        const fromHsv = () => { hex = rgbHex(hsvRgb(hsv)); paint(true); };
        let pointer = null;
        const track = event => {
            const rect = sv.getBoundingClientRect();
            hsv = {...hsv, s: clamp((event.clientX - rect.left) / rect.width, 0, 1), v: clamp(1 - (event.clientY - rect.top) / rect.height, 0, 1)};
            fromHsv();
        };
        sv.addEventListener('pointerdown', event => { pointer = event.pointerId; try { sv.setPointerCapture(pointer); } catch { /* 已结束 */ } track(event); event.preventDefault(); });
        sv.addEventListener('pointermove', event => { if (event.pointerId === pointer) track(event); });
        sv.addEventListener('pointerup', () => { pointer = null; });
        hue.addEventListener('input', () => { hsv = {...hsv, h: Number(hue.value)}; fromHsv(); });
        hexInput.addEventListener('input', () => {
            const next = normalizeHex(hexInput.value.startsWith('#') ? hexInput.value : `#${hexInput.value}`);
            if (next) { hex = next; hsv = rgbHsv(hexRgb(hex)); paint(true); }
        });
        paint(false);
        if (value === 'none') dot.classList.add('is-none');
        openPop(anchor, box, () => {
            if (picked && hex) { recentColors.splice(recentColors.indexOf(hex) >>> 0, recentColors.includes(hex) ? 1 : 0); recentColors.unshift(hex); recentColors.length = Math.min(recentColors.length, 8); }
        });
    }
    // ── 属性面板 ──────────────────────────────────────────────────────────
    // 行加到 rowTarget：平时是面板本身，样式、位置两组各在一个 fieldset 里，锁住时整组停用。
    let rowTarget = panelBody;
    function row(label, ...controls) {
        const node = make('div', 'qm-xs-row');
        node.append(make('span', 'qm-xs-row-label', label), ...controls);
        rowTarget.append(node);
        return node;
    }
    function group(disabled) {
        const node = make('fieldset', 'qm-xs-group');
        node.disabled = disabled;
        panelBody.append(node);
        rowTarget = node;
        return node;
    }
    function slider({value, min, max, step, unit = '', digits = 0, label = ''}, onValue) {
        const wrap = make('div', 'qm-xs-slider'), range = make('input'), number = make('input');
        range.type = 'range'; range.min = String(min); range.max = String(max); range.step = String(step);
        number.type = 'number'; number.min = String(min); number.max = String(max); number.step = String(step);
        if (label) { range.setAttribute('aria-label', label); number.setAttribute('aria-label', label); }
        const set = next => { range.value = String(next); number.value = Number(next).toFixed(digits); };
        set(clamp(Number(value) || 0, min, max));
        range.addEventListener('input', () => { number.value = Number(range.value).toFixed(digits); onValue(Number(range.value)); });
        number.addEventListener('change', () => {
            const next = Number(number.value);
            if (!Number.isFinite(next)) { set(range.value); return; }
            set(clamp(next, min, max)); onValue(clamp(next, min, max));
        });
        wrap.append(range, number);
        if (unit) wrap.append(make('span', 'qm-xs-unit', unit));
        return wrap;
    }
    function segmented(options, value, onValue) {
        const wrap = make('div', 'qm-xs-seg');
        for (const option of options) {
            const node = make('button', '', option.label); node.type = 'button';
            node.setAttribute('aria-pressed', String(option.value === value));
            if (option.title) node.title = option.title;
            node.addEventListener('click', () => {
                for (const other of wrap.children) other.setAttribute('aria-pressed', 'false');
                node.setAttribute('aria-pressed', 'true'); onValue(option.value);
            });
            wrap.append(node);
        }
        return wrap;
    }
    function colorControl(value, onValue, options = {}) {
        const node = make('button', 'qm-xs-color'), dot = make('span', 'qm-xs-dot'), label = make('span', 'qm-xs-hex');
        node.type = 'button';
        const show = next => {
            dot.classList.toggle('is-none', next === 'none'); dot.style.background = next === 'none' ? '' : next;
            label.textContent = next === 'none' ? '无' : next;
        };
        show(value);
        node.append(dot, label);
        node.addEventListener('click', () => openColorPicker(node, value, next => { value = next; show(next); onValue(next); }, options));
        return node;
    }
    function computedOf(element) {
        const node = nodeOf(element.id);
        const style = node ? view.getComputedStyle(node) : null;
        const size = Number.parseFloat(style?.fontSize) || 24;
        const lh = Number.parseFloat(style?.lineHeight);
        const ls = Number.parseFloat(style?.letterSpacing);
        return {
            size: Math.round(size), lh: Number.isFinite(lh) ? round(lh / size) : 1.6, ls: Number.isFinite(ls) ? round(ls / size) : 0,
            color: cssColorHex(style?.color) || doc.ink, align: ['left', 'center', 'right', 'justify'].includes(style?.textAlign) ? style.textAlign : 'left',
            weight: Number(style?.fontWeight) || 400, indent: round((Number.parseFloat(style?.textIndent) || 0) / size),
            gap: round((Number.parseFloat(style?.getPropertyValue('--qm-gap')) || 0.55)),
            stroke: cssColorHex(style?.borderTopColor) || doc.ink, strokeWidth: Number.parseFloat(style?.borderTopWidth) || 0,
            radius: Number.parseFloat(style?.borderTopLeftRadius) || 0, fill: cssColorHex(style?.backgroundColor) || 'none',
            // 隐藏的元素读不到样式，按它自己记的值或 1。
            opacity: style && !element.hidden ? Number(style.opacity) : element.props?.opacity ?? 1, nameColor: cssColorHex(style?.getPropertyValue('--qm-who')) || '',
            blend: style && !element.hidden && BLEND_MODES.includes(style.mixBlendMode) ? style.mixBlendMode : element.props?.blend || 'normal',
        };
    }
    // 改样式：ids 里样式没锁的一起改。只改样式的项（不改框里内容）只换行内样式；线条的样子画在 SVG 里，要重建。
    const CONTENT_PROPS = new Set(['stroke', 'strokeWidth', 'dash']);
    function setStyle(ids, key, value, reflow) {
        const targets = ids.map(findElement).filter(item => item && !styleLocked(item));
        if (!targets.length) return Promise.resolve();
        const restyle = targets.every(item => item.kind !== 'line' || !CONTENT_PROPS.has(key));
        const apply = item => { if (value === undefined) delete item.props[key]; else item.props[key] = value; };
        return change(next => { for (const target of targets) { const item = findIn(next, target.id); if (item) apply(item); } },
            {key: `${targets.map(item => item.id).join(',')}:${key}`, reflow, paint: {elements: targets.map(item => item.id), restyle}});
    }
    const setProp = (element, key, reflow) => value => setStyle([element.id], key, value, reflow);
    function renderPanel() {
        if (panelTab !== 'props') { propsDirty = true; panelShows = null; return; }
        propsDirty = false;
        panelBody.replaceChildren(); panelShows = null; rowTarget = panelBody;
        if (!doc) return;
        const elements = pickedElements();
        if (elements.length > 1) { panelShows = `multi:${picks.join(',')}`; multiPanel(elements); rowTarget = panelBody; return; }
        const element = elements[0];
        panelShows = element ? element.id : 'page';
        if (!element) { pagePanel(); return; }
        propsHead(KIND_LABEL[element.kind], [element]);
        // 内容（选图、裁切、选对话）不受样式锁；样式与位置各一组。
        if (element.kind === 'image') imageContent(element);
        if (element.kind === 'dialog') row('对话', textButton(`选择对话（${element.lines.length} 句）`, event => openDialoguePicker(event.currentTarget, element.id)));
        group(styleLocked(element));
        if (element.kind === 'text' || element.kind === 'body') textPanel(element);
        else if (element.kind === 'dialog') dialogPanel(element);
        else if (element.kind === 'image') strokeRows(element, computedOf(element), {radius: true});
        else if (element.kind === 'line') linePanel(element);
        else shapePanel(element);
        row('', textButton('恢复模板样式', () => edit(element.id, item => { item.props = {}; }).then(renderPanel), 'is-wide'));
        group(posLocked(element));
        geometryPanel(element);
        rowTarget = panelBody;
    }
    // 属性页顶上一行：选了什么，以及它的三个图层开关（隐藏、锁位置、锁样式），多选时对整组。
    function propsHead(title, elements) {
        const head = make('div', 'qm-xs-props-head'), tools = make('div', 'qm-xs-flags');
        head.append(make('span', 'qm-xs-props-title', title), tools);
        tools.append(...layerFlags(elements));
        panelBody.append(head);
    }
    function layerFlags(elements) {
        const ids = elements.map(item => item.id);
        const all = test => elements.every(test);
        const flag = (on, onLabel, offLabel, onIcon, offIcon, action) => {
            const node = button(on ? onLabel : offLabel, on ? onIcon : offIcon, action, {className: `qm-xs-flag${on ? ' is-on' : ''}`});
            node.setAttribute('aria-pressed', String(on));
            return node;
        };
        const hidden = all(item => item.hidden), pos = all(posLocked), style = all(styleLocked);
        return [
            flag(hidden, '显示', '隐藏', 'eyeOff', 'eye', () => setLayerFlag(ids, 'hidden', !hidden)),
            flag(pos, '解锁位置', '锁定位置', 'move', 'move', () => setLayerFlag(ids, 'pos', !pos)),
            flag(style, '解锁样式', '锁定样式', 'drop', 'drop', () => setLayerFlag(ids, 'style', !style)),
        ];
    }
    // 第一次选自定义时，从当前页的比例起步（约不成两位数以内的整数比就用 3:4）。
    function startingCustomRatio() {
        if (normalizeCustomRatio(doc.customRatio)) return doc.customRatio;
        if (normalizeCustomRatio(doc.ratio)) return doc.ratio;
        const height = pageHeight(doc), gcd = (a, b) => b ? gcd(b, a % b) : a, d = gcd(PAGE_WIDTH, height);
        return normalizeCustomRatio(`${PAGE_WIDTH / d}:${height / d}`) || '3:4';
    }
    function applyRatio(ratio, custom) {
        commitEditing();
        change(item => setRatio(item, ratio, custom)).then(() => { zoom = 0; fit(); renderPanel(); });
    }
    function customRatioFields() {
        const wrap = make('div', 'qm-xs-ratio'), [w, h] = (normalizeCustomRatio(doc.customRatio) || '3:4').split(':');
        const inputs = [['宽', w], ['高', h]].map(([label, value]) => {
            const field = make('label', 'qm-xs-geo-field'), input = make('input');
            input.type = 'number'; input.min = '1'; input.max = '99'; input.step = '1'; input.value = value; input.setAttribute('aria-label', label);
            field.append(make('span', '', label), input);
            return {field, input};
        });
        const commit = () => {
            const next = normalizeCustomRatio(inputs.map(({input}) => String(Math.round(Number(input.value)))).join(':'));
            if (!next) { const [a, b] = (doc.customRatio || '3:4').split(':'); inputs[0].input.value = a; inputs[1].input.value = b; return; }
            if (next !== doc.customRatio) applyRatio('custom', next);
        };
        for (const {input} of inputs) input.addEventListener('change', commit);
        wrap.append(inputs[0].field, make('span', 'qm-xs-ratio-sep', ':'), inputs[1].field);
        return wrap;
    }
    function pagePanel() {
        panelBody.append(make('div', 'qm-xs-props-head', '页面'));
        row('比例', segmented(RATIOS.map(ratio => ({value: ratio.key, label: ratio.label})), doc.ratio, value => {
            if (value === doc.ratio) return;
            applyRatio(value, value === 'custom' ? startingCustomRatio() : undefined);
        }));
        if (doc.ratio === 'custom') row('', customRatioFields());
        const paper = {reflow: false, paint: 'paper'};
        row('纸色', colorControl(doc.paper, value => change(item => { item.paper = value; }, {key: 'paper', ...paper})));
        row('杂色', slider({value: doc.grain.amount, min: 0, max: 100, step: 1, unit: '%'}, value => change(item => { item.grain.amount = value; }, {key: 'grain-amount', ...paper})));
        row('颗粒', slider({value: doc.grain.size, min: GRAIN_SIZES.min, max: GRAIN_SIZES.max, step: 1}, value => change(item => { item.grain.size = value; }, {key: 'grain-size', ...paper})));
        row('文字色', colorControl(doc.ink, value => change(item => { item.ink = value; }, {key: 'ink', ...paper})));
        const bgButtons = make('div', 'qm-xs-inline');
        bgButtons.append(textButton(doc.bg.image ? '换背景图' : '选背景图', () => pickImage('bg')));
        if (doc.bg.image) bgButtons.append(textButton('移除', () => change(item => { item.bg = {image: '', opacity: 1, w: 0, h: 0}; }, {reflow: false}).then(renderPanel)));
        row('背景图', bgButtons);
        if (doc.bg.image) row('透明度', slider({value: Math.round(doc.bg.opacity * 100), min: 0, max: 100, step: 1, unit: '%'}, value => change(item => { item.bg.opacity = value / 100; }, {key: 'bg-opacity', ...paper})));
        const pageButtons = make('div', 'qm-xs-inline');
        pageButtons.append(textButton('加一页', addPage));
        if (doc.pages.length > 1) pageButtons.append(textButton('删除本页', () => deletePage(pageIndex), 'is-danger'));
        row('页', pageButtons);
        const original = normalizeBody(content?.body);
        if (doc.body !== original) row('正文', textButton('恢复收藏原文', () => { commitEditing(); change(item => { item.body = original; }, {keepName: true}).then(renderPanel); }));
    }
    function fontSelect(value, onValue) {
        const select = make('select', 'qm-xs-select');
        const options = [['', '跟随模板'], ['serif', '宋体'], ['sans', '黑体'], ['kai', '楷体'], ...fontList.map(font => [font.id, font.name])];
        for (const [key, label] of options) { const option = make('option', '', label); option.value = key; select.append(option); }
        select.value = value || '';
        select.addEventListener('change', () => onValue(select.value || undefined));
        return select;
    }
    // 换字体总要走一次重排：字体库里的字体在那里注册。
    const fontRow = (ids, value) => row('字体', fontSelect(value, next => setStyle(ids, 'font', next, true)));
    function textPanel(element) {
        const c = computedOf(element), p = element.props, body = element.kind === 'body', reflow = body;
        fontRow([element.id], p.font);
        row('字号', slider({value: p.size ?? c.size, min: 8, max: 240, step: 1, unit: 'px'}, setProp(element, 'size', reflow)));
        row('字距', slider({value: p.ls ?? c.ls, min: -0.2, max: 1.5, step: 0.01, unit: 'em', digits: 2}, setProp(element, 'ls', reflow)));
        row('行高', slider({value: p.lh ?? c.lh, min: 0.8, max: 3.2, step: 0.05, unit: '倍', digits: 2}, setProp(element, 'lh', reflow)));
        if (body) {
            row('段距', slider({value: p.gap ?? c.gap, min: 0, max: 3, step: 0.05, unit: 'em', digits: 2}, setProp(element, 'gap', true)));
            row('缩进', slider({value: p.indent ?? c.indent, min: 0, max: 4, step: 0.5, unit: 'em', digits: 1}, setProp(element, 'indent', true)));
        }
        row('颜色', colorControl(p.color || c.color, setProp(element, 'color', false)));
        row('对齐', segmented([{value: 'left', label: '左'}, {value: 'center', label: '中'}, {value: 'right', label: '右'}, {value: 'justify', label: '两端'}],
            p.align || c.align, setProp(element, 'align', reflow)));
        row('粗细', segmented([{value: 300, label: '细'}, {value: 400, label: '常规'}, {value: 500, label: '中'}, {value: 700, label: '粗'}],
            p.weight ?? [300, 400, 500, 700].reduce((a, b) => Math.abs(b - c.weight) < Math.abs(a - c.weight) ? b : a), setProp(element, 'weight', reflow)));
        row('方向', segmented([{value: false, label: '横排'}, {value: true, label: '竖排'}], element.vertical === true,
            value => edit(element.id, item => { item.vertical = value; }, {reflow: true})));
    }
    function dialogPanel(element) {
        const c = computedOf(element), p = element.props;
        row('样式', segmented([{value: 'script', label: '名字：话'}, {value: 'bubble', label: '气泡'}], element.look === 'bubble' ? 'bubble' : 'script',
            value => edit(element.id, item => { item.look = value; }, {reflow: false})));
        fontRow([element.id], p.font);
        row('字号', slider({value: p.size ?? c.size, min: 8, max: 160, step: 1, unit: 'px'}, setProp(element, 'size', false)));
        row('行高', slider({value: p.lh ?? c.lh, min: 0.8, max: 3, step: 0.05, unit: '倍', digits: 2}, setProp(element, 'lh', false)));
        row('句距', slider({value: p.gap ?? c.gap, min: 0, max: 3, step: 0.05, unit: 'em', digits: 2}, setProp(element, 'gap', false)));
        row('字距', slider({value: p.ls ?? c.ls, min: -0.2, max: 1.5, step: 0.01, unit: 'em', digits: 2}, setProp(element, 'ls', false)));
        row('文字色', colorControl(p.color || c.color, setProp(element, 'color', false)));
        row('名字色', colorControl(p.nameColor || c.nameColor || p.color || c.color, setProp(element, 'nameColor', false)));
        row('方向', segmented([{value: false, label: '横排'}, {value: true, label: '竖排'}], element.vertical === true,
            value => edit(element.id, item => { item.vertical = value; }, {reflow: false})));
    }
    // 多选：全是文字类（文本框、正文框、对话）时一起改字体、字号、行高、字距、颜色；混着的只改颜色（文字色、填充、描边）。位置是整组的外接框。
    function multiPanel(elements) {
        propsHead(`${elements.length} 个元素`, elements);
        const ids = elements.map(item => item.id), primary = findElement(selected) || elements[0];
        const texts = elements.filter(item => TEXT_KINDS.has(item.kind)), allText = texts.length === elements.length;
        group(elements.every(styleLocked));
        if (allText) {
            const c = computedOf(primary), p = primary.props, reflow = texts.some(item => item.kind === 'body');
            const same = key => texts.every(item => item.props[key] === p[key]) ? p[key] : undefined;
            fontRow(ids, same('font'));
            row('字号', slider({value: p.size ?? c.size, min: 8, max: 240, step: 1, unit: 'px'}, value => setStyle(ids, 'size', value, reflow)));
            row('行高', slider({value: p.lh ?? c.lh, min: 0.8, max: 3.2, step: 0.05, unit: '倍', digits: 2}, value => setStyle(ids, 'lh', value, reflow)));
            row('字距', slider({value: p.ls ?? c.ls, min: -0.2, max: 1.5, step: 0.01, unit: 'em', digits: 2}, value => setStyle(ids, 'ls', value, reflow)));
            row('颜色', colorControl(p.color || c.color, value => setStyle(ids, 'color', value, false)));
        } else {
            if (texts.length) { const first = texts[0]; row('文字色', colorControl(first.props.color || computedOf(first).color, value => setStyle(texts.map(item => item.id), 'color', value, false))); }
            const shapes = elements.filter(item => item.kind === 'rect' || item.kind === 'ellipse');
            if (shapes.length) row('填充', colorControl(shapes[0].props.fill || computedOf(shapes[0]).fill, value => setStyle(shapes.map(item => item.id), 'fill', value, false), {allowNone: true}));
            const stroked = elements.filter(item => item.kind === 'rect' || item.kind === 'ellipse' || item.kind === 'image' || item.kind === 'line');
            if (stroked.length) { const first = stroked[0]; row('描边', colorControl(first.props.stroke || (first.kind === 'line' ? doc.ink : computedOf(first).stroke), value => setStyle(stroked.map(item => item.id), 'stroke', value, false))); }
        }
        const movable = elements.filter(item => !posLocked(item));
        group(!movable.length);
        groupGeometry(movable);
    }
    // 从伴读对话里挑句子：按时间顺序，打勾的进图。
    function openDialoguePicker(anchor, id) {
        const element = findElement(id), messages = content?.dialogue?.messages || [];
        if (!element) return;
        const chosen = new Set(element.lines.map(line => line.id).filter(Boolean));
        const box = make('div', 'qm-xs-pick');
        const list = make('div', 'qm-xs-pick-list');
        if (!messages.length) list.append(make('div', 'qm-xs-menu-empty', '这本书还没有对话'));
        for (const message of messages) {
            const label = make('label', `qm-xs-pick-row is-${message.who}`), check = make('input');
            check.type = 'checkbox'; check.checked = chosen.has(message.id);
            check.addEventListener('change', () => { if (check.checked) chosen.add(message.id); else chosen.delete(message.id); });
            const words = make('span', 'qm-xs-pick-text');
            words.append(make('b', '', message.name || (message.who === 'user' ? '我' : '书友')), document.createTextNode(` ${message.text}`));
            label.append(check, words);
            list.append(label);
        }
        const foot = make('div', 'qm-xs-ask-row');
        foot.append(textButton('取消', () => closePop()), textButton('确定', () => {
            const kept = element.lines.filter(line => !line.id);   // 手动改过来源的句子（没有编号）留着
            const picked = messages.filter(message => chosen.has(message.id)).map(message => ({id: message.id, who: message.who, name: message.name, text: message.text}));
            closePop();
            edit(id, item => { item.lines = normalizeLines([...picked, ...kept]); }, {reflow: false, keepName: true}).then(() => { renderPanel(); renderMini(); });
        }, 'is-primary'));
        box.append(make('div', 'qm-xs-ask-title', '选择书友对话'), list, foot);
        openPop(anchor, box);
        list.querySelector('input:checked')?.closest('label')?.scrollIntoView?.({block: 'center'});
    }
    function strokeRows(element, c, {fill = false, radius = false} = {}) {
        const p = element.props;
        if (fill) row('填充', colorControl(p.fill || c.fill, setProp(element, 'fill', false), {allowNone: true}));
        row('描边', colorControl(p.stroke || c.stroke, setProp(element, 'stroke', false)));
        row('粗细', slider({value: p.strokeWidth ?? c.strokeWidth, min: 0, max: 40, step: 0.5, unit: 'px', digits: 1}, setProp(element, 'strokeWidth', false)));
        if (radius) row('圆角', slider({value: p.radius ?? c.radius, min: 0, max: 400, step: 1, unit: 'px'}, setProp(element, 'radius', false)));
        row('虚线', segmented([{value: false, label: '实线'}, {value: true, label: '虚线'}], p.dash === true, setProp(element, 'dash', false)));
    }
    function imageContent(element) {
        const buttons = make('div', 'qm-xs-inline');
        buttons.append(textButton(element.image ? '换图' : '选图', () => pickImage(element.id)));
        if (element.image) {
            buttons.append(textButton(cropping === element.id ? '完成裁切' : '裁切', () => toggleCrop(element.id)));
            buttons.append(textButton('移除图片', () => { if (cropping) toggleCrop(cropping); edit(element.id, item => { item.image = null; }, {reflow: false}).then(() => { renderPanel(); renderMini(); }); }));
        }
        row('图片', buttons);
        if (element.image) row('缩放', slider({value: element.image.zoom, min: 1, max: 6, step: 0.01, unit: '倍', digits: 2},
            value => edit(element.id, item => { item.image.zoom = value; }, {key: `${element.id}:zoom`, reflow: false})));
    }
    function shapePanel(element) { strokeRows(element, computedOf(element), {fill: true, radius: element.kind === 'rect'}); }
    function linePanel(element) {
        const p = element.props;
        row('颜色', colorControl(p.stroke || doc.ink, setProp(element, 'stroke', false)));
        row('粗细', slider({value: p.strokeWidth ?? 1.5, min: 0.5, max: 30, step: 0.5, unit: 'px', digits: 1}, setProp(element, 'strokeWidth', false)));
        row('虚线', segmented([{value: false, label: '实线'}, {value: true, label: '虚线'}], p.dash === true, setProp(element, 'dash', false)));
    }
    function geoFields(read, onValue) {
        const grid = make('div', 'qm-xs-geo');
        for (const [key, label] of [['x', 'X'], ['y', 'Y'], ['w', '宽'], ['h', '高']]) {
            const field = make('label', 'qm-xs-geo-field'), input = make('input');
            input.type = 'number'; input.step = '1'; input.dataset.geo = key; input.value = String(Math.round(read()?.[key] ?? 0)); input.setAttribute('aria-label', label);
            input.addEventListener('change', () => {
                const value = Number(input.value);
                if (!Number.isFinite(value)) { input.value = String(Math.round(read()?.[key] ?? 0)); return; }
                onValue(key, value);
            });
            field.append(make('span', '', label), input);
            grid.append(field);
        }
        return grid;
    }
    function geometryPanel(element) {
        row('位置', geoFields(() => findElement(element.id), (key, value) =>
            edit(element.id, item => { item[key] = round(key === 'w' || key === 'h' ? Math.max(item.kind === 'line' ? 0 : 12, value) : value); })));
    }
    // 整组的位置：改 X / Y 平移，改宽 / 高按比例缩放组里各元素。
    function groupGeometry(movable) {
        const ids = movable.map(item => item.id);
        row('位置', geoFields(() => boundsOf(ids.map(findElement).filter(Boolean)), (key, value) => {
            const elements = ids.map(findElement).filter(Boolean), from = boundsOf(elements);
            if (!from) return;
            const to = {...from, [key]: key === 'w' || key === 'h' ? Math.max(12, value) : value};
            const origs = new Map(elements.map(item => [item.id, renderedBox(item)]));
            const reflow = (key === 'w' || key === 'h') && elements.some(item => item.kind === 'body');
            change(() => scaleGroup(origs, from, to), {reflow, paint: {elements: ids}}).then(renderPanelGeometry);
        }));
    }
    function renderPanelGeometry() {
        const box = selectionBox();
        if (!box) return;
        const source = isMulti() ? boundsOf(pickedElements().filter(item => !posLocked(item))) || box : findElement(selected);
        for (const input of panelBody.querySelectorAll('[data-geo]')) if (view.document.activeElement !== input) input.value = String(Math.round(source[input.dataset.geo]));
    }
    // ── 图层 ──────────────────────────────────────────────────────────────
    // 当前页的元素，最上层在最前。点一行选中（Shift／Ctrl 或多选模式下加减），行尾是隐藏、锁位置、锁样式；
    // 上面是选中元素的混合与不透明度，下面是层级。只在图层页看得见时才画，内容没变就不重画。
    function showTab(key, fromUser = false) {
        panelTab = key === 'layers' ? 'layers' : 'props';
        propsTab.setAttribute('aria-selected', String(panelTab === 'props')); layersTab.setAttribute('aria-selected', String(panelTab === 'layers'));
        panelBody.hidden = panelTab !== 'props'; layersBody.hidden = panelTab !== 'layers';
        if (fromUser && panel.classList.contains('is-collapsed')) { panel.classList.remove('is-collapsed'); requestAnimationFrame(fit); }
        if (panelTab === 'props' && (propsDirty || panelShows === null)) renderPanel();
        if (panelTab === 'layers') renderLayers();
    }
    function layerName(element, page) {
        if (element.kind === 'text') return element.text.replace(/\s+/g, ' ').trim().slice(0, 24) || KIND_LABEL.text;
        if (element.kind === 'body') {
            const bodies = page.elements.filter(item => item.kind === 'body');
            return bodies.length > 1 ? `${KIND_LABEL.body} ${element.flow + 1}` : KIND_LABEL.body;
        }
        return KIND_LABEL[element.kind];
    }
    function renderLayers() {
        if (panelTab !== 'layers' || !doc) { layersKey = ''; return; }
        const page = currentPage();
        if (!page) { layersBody.replaceChildren(); layersKey = ''; return; }
        const elements = pickedElements();
        const key = JSON.stringify([page.id, picks, exportJob ? 1 : 0, page.elements.map(item => [item.id, item.kind, item.hidden, item.lock.pos, item.lock.style,
            item.kind === 'text' ? item.text.slice(0, 24) : item.flow ?? 0, item.props.opacity ?? null, item.props.blend ?? null])]);
        if (key === layersKey) return;
        layersKey = key;
        const bar = make('div', 'qm-xs-layer-bar'), primary = findElement(selected);
        const styleTargets = elements.filter(item => !styleLocked(item)), ids = styleTargets.map(item => item.id);
        const c = primary ? computedOf(primary) : {opacity: 1, blend: 'normal'};
        const blend = make('select', 'qm-xs-select'); blend.setAttribute('aria-label', '混合模式'); blend.title = '混合模式';
        for (const mode of BLEND_MODES) { const option = make('option', '', BLEND_LABEL[mode]); option.value = mode; blend.append(option); }
        blend.value = primary?.props.blend || c.blend || 'normal';
        blend.addEventListener('change', () => setStyle(ids, 'blend', blend.value === 'normal' && c.blend === 'normal' ? undefined : blend.value, false));
        const opacity = slider({value: Math.round((primary?.props.opacity ?? c.opacity) * 100), min: 0, max: 100, step: 1, unit: '%', label: '不透明度'},
            value => setStyle(ids, 'opacity', round(value / 100), false));
        const disabled = !ids.length;
        blend.disabled = disabled; for (const input of opacity.querySelectorAll('input')) input.disabled = disabled;
        bar.append(blend, opacity);
        const list = make('div', 'qm-xs-layer-list'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', '图层');
        for (const element of [...page.elements].reverse()) {
            const on = picks.includes(element.id);
            const item = make('div', `qm-xs-layer${on ? ' is-on' : ''}${element.hidden ? ' is-hidden' : ''}`);
            const main = make('button', 'qm-xs-layer-main'); main.type = 'button';
            item.setAttribute('role', 'listitem'); main.setAttribute('aria-pressed', String(on));
            main.append(icon(KIND_ICON[element.kind]), make('span', 'qm-xs-layer-name', layerName(element, page)));
            main.addEventListener('click', event => {
                commitEditing();
                if (event.shiftKey || event.ctrlKey || event.metaKey || tool === 'multi') togglePick(element.id); else select(element.id);
            });
            item.append(main, ...layerFlags([element]));
            list.append(item);
        }
        const foot = make('div', 'qm-xs-layer-foot');
        for (const [where, label, name] of [['top', '置于顶层', 'top'], ['up', '上移一层', 'up'], ['down', '下移一层', 'down'], ['bottom', '置于底层', 'bottom']]) {
            const node = button(label, name, () => arrange(where));
            node.disabled = !elements.length;
            foot.append(node);
        }
        layersBody.replaceChildren(bar, list, foot);
    }
    // ── 页面条 ────────────────────────────────────────────────────────────
    // 页数、分页处与条宽都没变时，只重画改过的那几页缩略图（影子根里换页面节点），外层按钮不动。
    let thumbs = [], thumbDirty = null;
    function scheduleThumbs(pageId) {
        if (pageId === undefined || pageId === null) thumbDirty = 'all';
        else if (thumbDirty !== 'all') (thumbDirty ??= new Set()).add(pageId);
        clearTimeout(thumbTimer); thumbTimer = setTimeout(renderStrip, 220);
    }
    function markCurrentThumb() { thumbs.forEach((thumb, index) => thumb.item.classList.toggle('is-current', index === pageIndex)); }
    function thumbShape() {
        const narrow = view.innerWidth <= 760;
        return {narrow, width: narrow ? 36 : 48, maxHeight: narrow ? 64 : 96};
    }
    function paintThumb(thumb, page, info, shape) {
        const factor = shape.width / PAGE_WIDTH;
        thumb.frame.style.height = `${Math.min(shape.maxHeight, Math.round(info.h * factor))}px`;
        const css = `${BASE_CSS}\n${doc.template.css}\n.page{transform:scale(${factor});transform-origin:0 0}`;
        if (thumb.style.textContent !== css) thumb.style.textContent = css;
        const next = buildPage(document, doc, page, info, editorContext());
        if (thumb.page) thumb.page.replaceWith(next); else thumb.root.append(next);
        thumb.page = next;
    }
    function renderStrip() {
        clearTimeout(thumbTimer); thumbTimer = null;
        const dirty = thumbDirty; thumbDirty = null;
        if (!doc) { strip.replaceChildren(); thumbs = []; return; }
        const shape = thumbShape();
        const same = thumbs.length === doc.pages.length && doc.pages.every((page, index) => {
            const thumb = thumbs[index];
            return thumb.id === page.id && thumb.breakBefore === layoutFor(page).breakBefore && thumb.narrow === shape.narrow;
        });
        if (same) {
            doc.pages.forEach((page, index) => { if (dirty === 'all' || dirty?.has(page.id)) paintThumb(thumbs[index], page, layoutFor(page), shape); });
            markCurrentThumb();
            return;
        }
        thumbs = doc.pages.map((page, index) => {
            const info = layoutFor(page);
            const item = make('div', `qm-xs-thumb${index === pageIndex ? ' is-current' : ''}`);
            const open = make('button', 'qm-xs-thumb-open'); open.type = 'button'; open.title = `第 ${index + 1} 页`; open.setAttribute('aria-label', open.title);
            // 缩略图只是画面，不进无障碍树：按钮用「第 N 页」作名字，不必每次翻页从整页文字里重算。
            const frame = make('div', 'qm-xs-thumb-frame');
            frame.style.width = `${shape.width}px`; frame.setAttribute('aria-hidden', 'true');
            const root = frame.attachShadow({mode: 'open'}), style = make('style');
            root.append(style);
            const thumb = {id: page.id, breakBefore: info.breakBefore, narrow: shape.narrow, item, frame, root, style, page: null};
            paintThumb(thumb, page, info, shape);
            open.append(frame, make('span', 'qm-xs-thumb-no', String(index + 1)));
            open.addEventListener('click', () => goPage(index));
            item.append(open);
            if (info.breakBefore >= 0) item.append(button('取消这一处分页', 'merge', () => removeBreak(info.breakBefore), {className: 'qm-xs-thumb-tool'}));
            return thumb;
        });
        strip.replaceChildren(...thumbs.map(thumb => thumb.item), button('加一页', 'plus', addPage, {className: 'qm-xs-thumb-add'}));
    }

    // ── 模板 ──────────────────────────────────────────────────────────────
    function templateEntries() {
        const scope = content?.scope === 'reader' ? 'reader' : 'collection';
        const builtins = BUILTIN_TEMPLATES.filter(item => !item.scope || item.scope === scope).map(item => ({id: item.id, source: item.source, builtin: true, name: parseExcerptTemplate(item.source).template.name}));
        const customs = readSettings().templates.map(item => ({id: `custom:${item.id}`, raw: item, source: item.source, builtin: false,
            name: parseExcerptTemplate(item.source).template?.name || '未命名模板'}));
        return [...builtins, ...customs];
    }
    // 换模板或方案时沿用稿里已选的对话；稿里没有就用这条摘录默认配的。
    function currentLines(value) {
        for (const page of value.pages) { const dialog = page.elements.find(item => item.kind === 'dialog' && item.lines.length); if (dialog) return dialog.lines; }
        return content?.lines || [];
    }
    function applyTemplate(entry) {
        const parsed = parseExcerptTemplate(entry.source);
        if (!parsed.ok) { setStatus(parsed.error); return false; }
        commitEditing(); closePop();
        dropPicks(); pageIndex = 0;
        change(value => {
            const next = createDoc({template: parsed.template, templateId: entry.id, body: value.body, fields: value.fields, ratio: value.ratio,
                customRatio: value.customRatio, grain: value.grain, lines: currentLines(value)});
            next.bg = value.bg;
            for (const key of Object.keys(value)) delete value[key];
            Object.assign(value, next);
        }, {keepName: true}).then(() => { zoom = 0; fit(); renderPanel(); });
        return true;
    }
    function openTemplateMenu(anchor) {
        if (!doc || exportJob) return;
        const list = make('div', 'qm-xs-menu');
        for (const entry of templateEntries()) {
            const extra = [];
            if (entry.builtin) extra.push(button('以此为底版新建', 'copy', () => openTemplateEditor(null, entry.source.replace(/data-name="([^"]*)"/, (m, name) => `data-name="${name} 副本"`))));
            else {
                extra.push(button('编辑', 'edit', () => openTemplateEditor(entry.raw, entry.source)));
                extra.push(button('导出', 'download', () => { void download(new Blob([entry.source], {type: 'text/html'}), `千幕书摘模板-${safeName(entry.name)}.html`); }));
                extra.push(button('删除', 'trash', async () => {
                    if (!await askConfirm(templateButton, `删除模板「${entry.name}」？`, '删除')) return;
                    writeSettings(state => { state.templates = state.templates.filter(item => item.id !== entry.raw.id); });
                }));
            }
            list.append(menuRow(entry.name, () => applyTemplate(entry), {current: doc.templateId === entry.id, extra}));
        }
        const foot = make('div', 'qm-xs-menu-foot');
        foot.append(textButton('新建模板', () => openTemplateEditor(null, TEMPLATE_STARTER)), textButton('导入', () => { closePop(); templateInput.value = ''; templateInput.click(); }));
        list.append(foot);
        openPop(anchor, list);
    }
    function saveTemplate(raw, source) {
        const parsed = parseExcerptTemplate(source);
        if (!parsed.ok) return {error: parsed.error};
        const id = raw?.id || newId('t');
        const ok = writeSettings(state => {
            const at = state.templates.findIndex(item => item.id === id);
            if (at < 0 && state.templates.length >= TEMPLATE_LIMIT) { setStatus(`自建模板最多 ${TEMPLATE_LIMIT} 个`); return false; }
            const record = {id, source, updatedAt: Date.now()};
            if (at < 0) state.templates.push(record); else state.templates[at] = record;
        });
        return ok ? {id: `custom:${id}`} : {error: '模板没能保存'};
    }
    function openTemplateEditor(raw, source) {
        closePop();
        editor.replaceChildren();
        const head = make('div', 'qm-xs-tpl-head'), title = make('span', 'qm-xs-tpl-title', raw ? '编辑模板' : '新建模板');
        const area = make('textarea', 'qm-xs-code'); area.spellcheck = false; area.value = source;
        const error = make('div', 'qm-xs-tpl-error'); error.setAttribute('role', 'alert');
        const copyGuide = async () => {
            try { await view.navigator.clipboard.writeText(`${TEMPLATE_GUIDE}\n\n—— 底版 ——\n${TEMPLATE_STARTER}`); setStatus('说明与底版已复制'); }
            catch { area.value = `<!--\n${TEMPLATE_GUIDE}\n-->\n${area.value}`; setStatus('说明已放进编辑框'); }
        };
        const save = () => {
            const result = saveTemplate(raw, area.value);
            if (result.error) { error.textContent = result.error; return; }
            editor.hidden = true; editor.replaceChildren();
            applyTemplate({id: result.id, source: area.value});
        };
        head.append(title, textButton('复制说明', copyGuide), textButton('取消', () => { editor.hidden = true; editor.replaceChildren(); }), textButton('保存并使用', save, 'is-primary'));
        editor.append(head, error, area);
        editor.hidden = false; area.focus();
    }
    templateInput.addEventListener('change', async () => {
        const file = templateInput.files?.[0];
        templateInput.value = '';
        if (!file) return;
        if (file.size > 200_000) { setStatus('模板超过 200KB'); return; }
        const source = await file.text();
        const result = saveTemplate(null, source);
        if (result.error) { setStatus(`导入失败：${result.error}`); return; }
        applyTemplate({id: result.id, source});
        setStatus('模板已导入');
    });
    // ── 方案 ──────────────────────────────────────────────────────────────
    function applyScheme(item) {
        commitEditing(); closePop();
        dropPicks(); pageIndex = 0;
        change(value => {
            const next = createDocFromScheme(item.scheme, {body: value.body, fields: value.fields, lines: currentLines(value), name: item.name});
            for (const key of Object.keys(value)) delete value[key];
            Object.assign(value, next);
        }, {keepName: true}).then(() => { zoom = 0; fit(); renderPanel(); });
    }
    // 存成方案或覆盖方案后，这份稿就叫这个方案名（不进撤销记录）。
    function nameDoc(name) {
        if (!doc) return;
        doc.name = name; dirtyLast = true; scheduleSave(); paintStatus();
    }
    function openSchemeMenu(anchor) {
        if (!doc || exportJob) return;
        const list = make('div', 'qm-xs-menu'), state = readSettings();
        for (const item of state.schemes) {
            const extra = [
                button('改名', 'edit', async () => {
                    const name = await askText(schemeButton, '方案名称', item.name);
                    if (name && writeSettings(next => { const found = next.schemes.find(entry => entry.id === item.id); if (found) found.name = name; }) && doc?.name === item.name) nameDoc(name);
                }),
                button('用当前版式覆盖', 'check', async () => {
                    if (!await askConfirm(schemeButton, `用当前版式覆盖「${item.name}」？`, '覆盖')) return;
                    if (!doc) return;
                    const before = doc.name;
                    doc.name = item.name;
                    if (writeSettings(next => { const found = next.schemes.find(entry => entry.id === item.id); if (found) found.scheme = schemeFromDoc(doc); })) { nameDoc(item.name); setStatus('方案已更新'); }
                    else doc.name = before;
                }),
                button('删除', 'trash', async () => {
                    if (!await askConfirm(schemeButton, `删除方案「${item.name}」？`, '删除')) return;
                    writeSettings(next => { next.schemes = next.schemes.filter(entry => entry.id !== item.id); });
                }),
            ];
            list.append(menuRow(item.name, () => applyScheme(item), {extra}));
        }
        if (!state.schemes.length) list.append(make('div', 'qm-xs-menu-empty', '还没有方案'));
        const foot = make('div', 'qm-xs-menu-foot');
        foot.append(textButton('存为方案', async () => {
            const name = await askText(schemeButton, '方案名称', `方案 ${state.schemes.length + 1}`);
            if (!name || !doc) return;
            const before = doc.name;
            doc.name = name;
            const ok = writeSettings(next => {
                if (next.schemes.length >= SCHEME_LIMIT) { setStatus(`方案最多 ${SCHEME_LIMIT} 个`); return false; }
                next.schemes.push({id: newId('s'), name, scheme: schemeFromDoc(doc)});
            });
            if (ok) { nameDoc(name); setStatus('已存为方案'); } else doc.name = before;
        }, 'is-primary'));
        list.append(foot);
        openPop(anchor, list);
    }

    // ── 导出 ──────────────────────────────────────────────────────────────
    async function startExport() {
        if (!doc || exportJob || !current()) return;
        commitEditing(); closePop();
        if (cropping) toggleCrop(cropping);
        select(null);
        await relayout();
        const job = {controller: new AbortController(), count: 0}, signal = job.controller.signal;
        exportJob = job; updateTop(); renderMini();
        const stopped = () => { if (signal.aborted || exportJob !== job || !visible) throw new DOMException('已停止', 'AbortError'); };
        try {
            const usage = new Map();
            for (const page of doc.pages) {
                const info = layoutFor(page);
                for (const element of page.elements) {
                    const font = element.props?.font;
                    if (!font || FONT_STACKS[font] || !families.has(font)) continue;
                    const slice = info.slices[element.id];
                    const text = element.kind === 'text' ? element.text : element.kind === 'body' && slice ? doc.body.slice(slice.start, slice.end) : '';
                    usage.set(font, `${usage.get(font) || ''}${text}`);
                }
            }
            if (usage.size) setStatus('正在准备字体…', true);
            const embedded = usage.size && fontProvider?.faces ? await embedFonts(usage, {faces: id => fontProvider.faces(id), signal}) : {families: new Map(), css: ''};
            stopped();
            const images = new Map();
            for (const id of new Set(imageIdsOf(doc))) {
                const record = await store.getImage(id).catch(() => null);
                if (record?.blob) images.set(id, await blobToDataUrl(record.blob));
                stopped();
            }
            const context = {families: embedded.families, imageSrc: id => images.get(id) || '', grainTile, omitHidden: true};
            const css = `${embedded.css}\n${BASE_CSS}\n${doc.template.css}`;
            const base = safeName(content.filename || content.fields.char || content.fields.pair || '书摘');
            for (let index = 0; index < doc.pages.length; index++) {
                stopped();
                setStatus(`正在导出 ${index + 1}/${doc.pages.length}`, true);
                const page = doc.pages[index], info = layoutFor(page), height = Math.round(info.h);
                const markup = pageSvg(document, buildPage(document, doc, page, info, context), css, PAGE_WIDTH, height);
                const blob = await svgToPng(document, markup, PAGE_WIDTH, height, signal);
                stopped();
                if (typeof verifyAccount === 'function' && await verifyAccount({signal, isCurrent: () => exportJob === job}) === false) throw new Error('账户已变化');
                stopped();
                if (await download(blob, `千幕书摘-${base}-${String(index + 1).padStart(2, '0')}.png`) === false) throw new Error('下载没有开始');
                job.count++;
            }
            setStatus(job.count > 1 ? `已保存 ${job.count} 张图片` : '已保存图片');
        } catch (error) {
            if (error?.name === 'AbortError') setStatus(job.count ? `已停止，保存了 ${job.count} 张` : '已停止');
            else {
                console.warn('[千幕] 书摘导出失败', error);
                setStatus(job.count ? `保存了 ${job.count} 张，其余没完成` : error?.name === 'SecurityError' ? '这个浏览器不支持导出成图' : '导出没完成，请重试');
            }
        } finally {
            if (exportJob === job) exportJob = null;
            updateTop(); renderMini();
        }
    }

    // ── 全屏与预览 ────────────────────────────────────────────────────────
    // 窄屏（与样式表的手机排布同一断点）上这个按钮是「预览」：只看成图，铺满屏幕，左右滑或点箭头翻页，轻点、关闭、返回退出。
    const narrowQuery = view?.matchMedia?.('(max-width: 760px)') || null;
    const isNarrow = () => narrowQuery?.matches === true;
    function setFullIcon(on) {
        const narrow = isNarrow();
        fullButton.querySelector('.qm-xs-icon').replaceWith(icon(narrow ? 'preview' : on ? 'unfull' : 'full'));
        fullButton.title = narrow ? '预览' : on ? '退出全屏' : '全屏'; fullButton.setAttribute('aria-label', fullButton.title);
    }
    const onNarrowChange = () => { if (!isNarrow() && dialog.classList.contains('is-full')) toggleFull(false); setFullIcon(dialog.classList.contains('is-full')); };
    narrowQuery?.addEventListener?.('change', onNarrowChange);
    function onFullButton() { if (isNarrow()) openPreview(); else toggleFull(); }
    const previewBox = make('div', 'qm-xs-preview'), previewStage = make('div', 'qm-xs-preview-stage'), previewHost = make('div', 'qm-xs-preview-host');
    const previewShadow = previewHost.attachShadow({mode: 'open'}), previewCount = make('span', 'qm-xs-preview-count');
    const previewPrev = button('上一页', 'prev', () => turnPreview(-1), {className: 'qm-xs-preview-turn is-prev'});
    const previewNext = button('下一页', 'next', () => turnPreview(1), {className: 'qm-xs-preview-turn is-next'});
    previewStage.append(previewHost);
    previewBox.append(previewStage, previewPrev, previewNext, previewCount, button('关闭预览', 'close', () => closePreview(), {className: 'qm-xs-preview-close'}));
    previewBox.hidden = true;
    dialog.append(previewBox);
    setTool('select'); showTab('props');
    function openPreview() {
        if (!doc || exportJob || preview) return;
        commitEditing(); closePop();
        preview = {index: pageIndex, swipe: null, pushed: false};
        previewBox.hidden = false;
        // 手机的返回键先退出预览：压一条同址的历史记录，退出时收回。
        try { view.history.pushState({...(view.history.state || {}), qmExcerptPreview: true}, ''); preview.pushed = true; }
        catch (error) { console.warn('[千幕] 预览没能接管返回键', error); }
        view.addEventListener('popstate', onPreviewPop);
        renderPreview();
    }
    function closePreview(fromHistory = false) {
        if (!preview) return;
        const {pushed} = preview;
        preview = null;
        previewBox.hidden = true; previewShadow.replaceChildren();
        view.removeEventListener('popstate', onPreviewPop);
        if (pushed && !fromHistory && view.history.state?.qmExcerptPreview) view.history.back();
    }
    function onPreviewPop() { closePreview(true); }
    function turnPreview(step) {
        if (!preview || !doc) return;
        const next = clamp(preview.index + step, 0, doc.pages.length - 1);
        if (next !== preview.index) { preview.index = next; renderPreview(); }
    }
    function renderPreview() {
        if (!preview || !doc) return;
        preview.index = clamp(preview.index, 0, doc.pages.length - 1);
        const page = doc.pages[preview.index], info = layoutFor(page);
        const style = make('style'); style.textContent = `${BASE_CSS}\n${doc.template.css}`;
        previewShadow.replaceChildren(style, buildPage(document, doc, page, info, editorContext()));
        const many = doc.pages.length > 1;
        previewPrev.hidden = !many || preview.index === 0; previewNext.hidden = !many || preview.index === doc.pages.length - 1;
        previewCount.hidden = !many; previewCount.textContent = `${preview.index + 1} / ${doc.pages.length}`;
        fitPreview(info.h);
    }
    function fitPreview(height = layoutFor(doc?.pages[preview?.index]).h) {
        if (!preview) return;
        const width = previewStage.clientWidth - 16, room = previewStage.clientHeight - 16;
        if (width <= 0 || room <= 0) return;
        const factor = Math.min(width / PAGE_WIDTH, room / height);
        previewHost.style.width = `${PAGE_WIDTH}px`; previewHost.style.height = `${height}px`;
        previewHost.style.transform = `translate(-50%, -50%) scale(${factor})`;
    }
    // 轻点退出，横向滑动翻页。
    previewStage.addEventListener('pointerdown', event => { if (preview) preview.swipe = {x: event.clientX, y: event.clientY, id: event.pointerId}; });
    previewStage.addEventListener('pointerup', event => {
        const swipe = preview?.swipe;
        if (!swipe || swipe.id !== event.pointerId) return;
        preview.swipe = null;
        const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.2) turnPreview(dx < 0 ? 1 : -1);
        else if (Math.hypot(dx, dy) < 10) closePreview();
    });
    previewStage.addEventListener('pointercancel', () => { if (preview) preview.swipe = null; });
    const previewResize = view?.ResizeObserver ? new view.ResizeObserver(() => fitPreview()) : null;
    previewResize?.observe(previewStage);
    function toggleFull(force) {
        const on = force ?? !dialog.classList.contains('is-full');
        dialog.classList.toggle('is-full', on); setFullIcon(on);
        try {
            if (on && dialog.requestFullscreen && !document.fullscreenElement) void dialog.requestFullscreen().catch(() => {});
            if (!on && document.fullscreenElement === dialog) void document.exitFullscreen?.().catch(() => {});
        } catch { /* 不支持真全屏时，铺满窗口即可 */ }
        requestAnimationFrame(() => fit());
    }
    const onFullscreenChange = () => { if (visible && document.fullscreenElement !== dialog && dialog.classList.contains('is-full')) { dialog.classList.remove('is-full'); setFullIcon(false); requestAnimationFrame(() => fit()); } };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    // ── 打开与关闭 ────────────────────────────────────────────────────────
    function ensureStyles() {
        if (stylesheet?.loaded) return stylesheet.loaded;
        const link = make('link'); link.rel = 'stylesheet'; link.href = EXCERPT_STUDIO_STYLESHEET.href;
        stylesheet = {link, loaded: new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('成图页样式加载超时')), 15000);
            link.addEventListener('load', () => { clearTimeout(timer); resolve(); }, {once: true});
            link.addEventListener('error', () => { clearTimeout(timer); reject(new Error('成图页样式加载失败')); }, {once: true});
        })};
        stylesheet.loaded.catch(() => { link.remove(); stylesheet = null; });
        document.head.append(link);
        return stylesheet.loaded;
    }
    function freshDoc() {
        const state = readSettings();
        const reader = content.scope === 'reader', last = reader ? state.lastReader : state.last;
        if (last) return createDocFromScheme(last, content);
        const templateId = reader ? 'builtin:coread' : 'builtin:book';
        return createDoc({template: builtinTemplate(templateId), templateId, body: content.body, fields: content.fields, lines: content.lines});
    }
    async function sweep() {
        try {
            const state = readSettings();
            const keep = [...imageIdsOf(state.last), ...imageIdsOf(state.lastReader), ...state.schemes.flatMap(item => imageIdsOf(item.scheme)), ...imageIdsOf(doc)];
            await store.sweepImages(keep);
        } catch { /* 清理失败不影响编辑，下次打开再清 */ }
    }
    // input：{key 稿件键, stamp 原文更新标记, body 原文, fields 占位字段, scope, dialogue, lines, filename}
    async function open(input) {
        if (!current() || typeof input?.key !== 'string' || typeof input.body !== 'string' || !input.body.trim()) return false;
        if (visible) close();
        // scope：collection 正文收藏／reader 伴读；dialogue：伴读里这本书的对话（可选入图）；lines：这条摘录默认配的几句。
        const messages = (Array.isArray(input.dialogue?.messages) ? input.dialogue.messages : []).slice(-200).flatMap(message => normalizeLines([message]));
        content = {key: input.key, stamp: String(input.stamp ?? ''), body: input.body, fields: {...(input.fields || {})}, scope: input.scope === 'reader' ? 'reader' : 'collection',
            dialogue: messages.length ? {messages} : null, lines: normalizeLines(input.lines || []), filename: typeof input.filename === 'string' ? input.filename : ''};
        dialogueButton.hidden = !content.dialogue;
        visible = true;
        try { await ensureStyles(); } catch (error) { visible = false; content = null; throw error; }
        if (!visible || !current()) return false;
        parent.append(dialog);
        if (!dialog.open) dialog.showModal();
        setStatus('正在排版…', true);
        try {
            store ??= createExcerptStore({namespace});
            try { fontProvider = (await fonts?.()) || null; } catch { fontProvider = null; }
            fontList = (() => { try { return fontProvider?.list?.() || []; } catch { return []; } })();
            let saved = null;
            try { saved = await store.loadDraft(content.key); } catch { saved = null; }
            if (!visible) return false;
            doc = (saved && saved.stamp === content.stamp && normalizeDoc(saved.doc)) || freshDoc();
            history = []; future = []; pageIndex = 0; picks = []; selected = null; editing = null; cropping = null; layersKey = ''; zoom = 0; dirtyLast = false;
            layoutHints.clear(); miniKey = ''; setFullIcon(false);
            setStatus('');
            await relayout();
            if (!visible) return false;
            renderPanel(); renderLayers(); renderStrip(); updateTop();
            if (!swept) { swept = true; void sweep(); }
            return true;
        } catch (error) {
            console.warn('[千幕] 书摘成图打开失败', error);
            setStatus('打开没完成，请关闭后重试', true);
            return false;
        }
    }
    function close() {
        if (!visible) return;
        commitEditing(); closePop(); closePreview();
        exportJob?.controller.abort(); exportJob = null;
        flushSave(); flushLast();
        visible = false;
        if (document.fullscreenElement === dialog) void document.exitFullscreen?.().catch(() => {});
        dialog.classList.remove('is-full', 'is-busy'); setFullIcon(false);
        if (dialog.open) dialog.close();
        dialog.remove();
        editor.hidden = true; editor.replaceChildren();
        for (const url of imageUrls.values()) if (url) URL.revokeObjectURL(url);
        imageUrls.clear(); families.clear(); fontFailed.clear();
        measurer?.dispose(); measurer = null; measurerCss = null;
        try { fontProvider?.release?.(); } catch { /* 字体库已关 */ }
        fontProvider = null; fontList = [];
        clearTimeout(thumbTimer); clearTimeout(statusTimer);
        doc = null; content = null; layout = {pages: [], remaining: 0, stuck: false}; pageNode = null;
        history = []; future = []; picks = []; selected = null; drag = null; guides = [];
        shadow.replaceChildren(); overlay.replaceChildren(); strip.replaceChildren(); panelBody.replaceChildren(); layersBody.replaceChildren(); mini.replaceChildren(); layersKey = '';
        thumbs = []; thumbDirty = null; miniKey = ''; miniSize = null; panelShows = null; sheetOffset = null; layoutHints.clear(); grainTiles.clear();
        statusMessage = ''; status.textContent = ''; status.title = '';
    }
    function dispose() {
        if (disposed) return;
        close(); disposed = true;
        resizeObserver?.disconnect(); previewResize?.disconnect();
        narrowQuery?.removeEventListener?.('change', onNarrowChange);
        document.removeEventListener('fullscreenchange', onFullscreenChange);
        stylesheet?.link.remove(); stylesheet = null;
        store?.close(); store = null;
    }
    return Object.freeze({open, close, dispose, get visible() { return visible; }});
}
