import {qianmuIconElement} from './qianmu-icon-renderer.js?v=1.59.416';
import {exportTextCollectionImages} from './qianmu-text-collection-images.js';

export const TEXT_COLLECTION_IMAGE_DIALOG_STYLESHEET = new URL('./qianmu-text-collection-image-dialog.css', import.meta.url);

// This view receives one confirmed text snapshot. It does not reload the library,
// update a collection item, or retain generated canvases and image URLs.
export function createTextCollectionImageDialog({parent, isCurrent, verifyAccount, download, exportImages = exportTextCollectionImages} = {}) {
    const doc = parent?.ownerDocument;
    if (!doc || typeof isCurrent !== 'function' || typeof exportImages !== 'function') {
        throw new TypeError('Collection image export requires its owner and exporter');
    }
    const make = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    let disposed = false, visible = false, generation = 0, attempt = null, snapshot = null, returnFocus = null;
    const dialog = make('dialog', 'qm-collection-image-dialog');
    dialog.setAttribute('aria-label', '收藏存图');
    const heading = make('header'), title = make('h2', '', '保存成图');
    const iconButton = (label, icon, action) => {
        const node = make('button'); node.type = 'button';
        setIcon(node, label, icon);
        node.addEventListener('click', () => { if (!node.disabled && visible && current()) action(); });
        return node;
    };
    const closeButton = iconButton('关闭收藏存图', 'x', close);
    heading.append(title, closeButton);
    const markLabel = make('label', 'qm-collection-image-mark');
    const marked = make('input'); marked.type = 'checkbox'; marked.setAttribute('aria-label', '添加标注');
    markLabel.append(marked, make('span', '', '添加标注'));
    const fields = make('div', 'qm-collection-image-fields');
    const headerLabel = make('label'), footerLabel = make('label');
    const headerInput = make('textarea'), footerInput = make('textarea');
    headerInput.rows = footerInput.rows = 2;
    headerInput.setAttribute('aria-label', '页眉'); footerInput.setAttribute('aria-label', '页尾');
    headerLabel.append(make('span', '', '页眉'), headerInput);
    footerLabel.append(make('span', '', '页尾'), footerInput);
    fields.append(headerLabel, footerLabel);
    marked.addEventListener('change', () => { if (visible && current() && !attempt) render(); });
    const status = make('p', 'qm-collection-image-status'); status.setAttribute('role', 'status');
    const footer = make('footer');
    const exportButton = iconButton('下载图片', 'download-simple', () => attempt ? stop() : start());
    footer.append(exportButton); dialog.append(heading, markLabel, fields, status, footer);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    // Native close events are queued. A close from a previous opening must not
    // dismiss the next opening of this same owned dialog.
    dialog.addEventListener('close', () => { if (!dialog.open) close(); });
    for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change', 'paste', 'cut', 'click']) {
        dialog.addEventListener(type, event => event.stopPropagation());
    }

    function setIcon(node, label, name) {
        node.title = label; node.setAttribute('aria-label', label);
        const glyph = qianmuIconElement(`qm-regular-${name}`, {document: doc});
        node.replaceChildren(...(glyph ? [glyph] : []));
    }
    function current() {
        if (disposed) return false;
        let valid = false;
        try { valid = isCurrent() === true; } catch { /* Missing owner is not permission to export. */ }
        if (!valid) dispose();
        return valid;
    }
    function render() {
        if (!visible || !current()) return;
        dialog.setAttribute('aria-busy', String(!!attempt));
        marked.disabled = headerInput.disabled = footerInput.disabled = !!attempt;
        fields.hidden = !marked.checked;
        setIcon(exportButton, attempt ? '停止导出' : '下载图片', attempt ? 'stop' : 'download-simple');
        status.hidden = !status.textContent;
    }
    function abortError() { return new DOMException('Collection image export cancelled', 'AbortError'); }
    function message(count, stopped = false) {
        const prefix = stopped ? '已停止。' : '';
        if (!count) return stopped ? '已停止。' : '未导出图片，请重试。';
        return `${prefix}已发起 ${count} 张图片下载。${count > 1 ? '如有拦截，请允许浏览器下载多个文件。' : ''}`;
    }
    async function start() {
        if (attempt || !snapshot || !visible || !current()) return;
        if (typeof verifyAccount !== 'function' || typeof download !== 'function') {
            status.textContent = '当前无法下载图片，请重新打开。'; render(); return;
        }
        const job = {controller: new AbortController(), generation, count: 0};
        attempt = job; status.textContent = ''; render();
        const active = () => attempt === job && job.generation === generation && !job.controller.signal.aborted && visible && current();
        const assertActive = () => { if (!active()) throw abortError(); };
        const account = async () => {
            assertActive();
            const verified = await verifyAccount({signal: job.controller.signal, isCurrent: active});
            assertActive();
            if (verified === false) throw Error('Collection account could not be verified');
        };
        const payload = {
            text: snapshot.text,
            header: marked.checked ? headerInput.value : '',
            footer: marked.checked ? footerInput.value : '',
        };
        try {
            await account();
            const style = doc.defaultView.getComputedStyle(dialog);
            const proseFont = style.getPropertyValue?.('--qm-prose-font')?.trim();
            const proseSize = style.getPropertyValue?.('--qm-prose-size')?.trim() || '';
            const fontSize = /^(?:\d+(?:\.\d+)?|\.\d+)px$/i.test(proseSize) ? Number.parseFloat(proseSize) * 2 : undefined;
            await exportImages({
                ...payload, foreground: style.color, background: style.backgroundColor,
                fontFamily: proseFont || style.fontFamily, fontSize,
                document: doc, signal: job.controller.signal, isCurrent: active,
                download: async (blob, name) => {
                    await account();
                    const result = await download(blob, name);
                    if (result === false) throw Error('Collection image download was not started');
                    job.count++;
                    assertActive();
                    return result;
                },
            });
            if (active()) status.textContent = message(job.count);
        } catch {
            if (active()) status.textContent = job.count
                ? `已发起 ${job.count} 张图片下载，后续导出未完成，请重试。`
                : '未导出图片，请重试。';
        } finally {
            if (attempt === job && job.generation === generation && visible && current()) {
                attempt = null; render();
            }
        }
    }
    function stop() {
        if (!attempt) return;
        const job = attempt;
        attempt = null; job.controller.abort();
        status.textContent = message(job.count, true); render();
    }
    function open(item) {
        if (!current() || typeof item?.text !== 'string' || !item.text.trim()
            || typeof item.charName !== 'string' || typeof item.userName !== 'string'
            || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) return false;
        // Replace an old export only after the new item has been validated.
        attempt?.controller.abort(); attempt = null; generation++;
        if (!visible) returnFocus = doc.activeElement;
        snapshot = {text: item.text};
        marked.checked = true;
        headerInput.value = `${item.charName || '未命名角色'} & ${item.userName || '未命名用户'}`;
        footerInput.value = new Date(item.createdAt).toLocaleDateString('zh-CN');
        status.textContent = ''; visible = true; parent.append(dialog); render();
        if (!dialog.open) dialog.showModal();
        exportButton.focus(); return true;
    }
    function close() {
        if (!visible) return;
        const ownedFocus = dialog.contains(doc.activeElement);
        visible = false; generation++; attempt?.controller.abort(); attempt = null; snapshot = null;
        headerInput.value = footerInput.value = status.textContent = '';
        dialog.close(); dialog.remove();
        if (ownedFocus && returnFocus?.isConnected) returnFocus.focus({preventScroll: true});
        returnFocus = null;
    }
    function dispose() { close(); disposed = true; }
    return Object.freeze({open, close, dispose});
}
