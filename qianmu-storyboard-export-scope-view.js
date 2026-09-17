import { captureStoryboardExportImages } from './qianmu-storyboard-export-scope.js';
import { htmlEscape as escape } from './qianmu-storyboard-utils.js';

// Metadata-only chooser in the existing export path. No media previews, network,
// source discovery, mutation or new archive format. Cancel means no export.
export function chooseStoryboardExportImages({ parent, chatKey, readRecords, guard, timeoutMs = 15000 } = {}) {
    const document = parent?.ownerDocument, view = document?.defaultView;
    if (!document || !parent.isConnected || !parent.classList.contains('open')) return Promise.resolve(null);
    const captured = captureStoryboardExportImages(readRecords()), selected = new Set(captured.rows.map(row => row.id));
    const dialog = document.createElement('dialog'); dialog.className = 'sd-bundle-dialog sd-gallery-directory'; dialog.setAttribute('aria-label', '选择备份静帧');
    let page = 0, busy = false, closed = false, resolve, timer, notice = '', activeGuard;
    const focused = document.activeElement, finished = new Promise(done => resolve = done);
    const alive = () => !closed && parent.isConnected && parent.classList.contains('open') && dialog.isConnected;
    function finish(value) {
        if (closed) return; closed = true; clearTimeout(timer); activeGuard?.(); observer.disconnect(); view.removeEventListener('pagehide', cancel);
        if (dialog.open) dialog.close(); dialog.remove(); if (focused?.isConnected) focused.focus({ preventScroll: true }); resolve(value);
    }
    const cancel = () => finish(null);
    const observer = new view.MutationObserver(records => {
        if (!alive() || records.some(row => row.target === parent && row.type === 'attributes' && !row.oldValue?.split(/\s+/).includes('open'))) cancel();
    });
    const count = () => dialog.querySelector('[data-export-count]').textContent = `已选 ${selected.size} / ${captured.rows.length} 张`;
    function draw() {
        if (!alive()) return;
        const focusAction = dialog.contains(document.activeElement) ? document.activeElement.dataset.exportAction : null;
        const list = captured.rows.slice(page * 24, (page + 1) * 24);
        dialog.innerHTML = `<header><b>选择备份静帧</b><button type="button" class="sd-btn" data-export-action="cancel">取消</button></header><main>
          <h3>当前聊天 · ${escape(chatKey)}</h3><p>仅缩小静帧原图和对应配方范围。通用分镜配置、日志、工作流、角色库及相关资源仍按原联包规则保留，不是仅含这些图片的小包，也不是全部聊天备份。</p>
          <p>本轮可分批选择以减少原图体积；每包仍受配置段 128 MiB、完整联包 512 MiB 上限约束。任一所选原图或必需资源缺失，会停止导出，不下载缺件包。</p>
          <fieldset ${busy ? 'disabled' : ''}><nav><button type="button" class="sd-btn" data-export-action="all">全选当前聊天</button><button type="button" class="sd-btn" data-export-action="none">清空选择</button><span data-export-count aria-live="polite"></span></nav>
          <div class="sd-directory-rows">${list.map((row, i) => `<label class="sd-directory-row"><input type="checkbox" data-export-image="${page * 24 + i}" ${selected.has(row.id) ? 'checked' : ''}><span><b>${escape(row.label || row.id)}</b><small>${row.floor === null ? '未关联段落' : `第 ${row.floor} 层`} · ${escape(row.createdAt === null ? '生成时间未记录' : new Date(row.createdAt).toLocaleString())}</small></span></label>`).join('') || '<p>当前聊天没有静帧；本次仅备份通用配置与资源库。</p>'}</div>
          <nav><button type="button" class="sd-btn" data-export-action="previous" ${page === 0 ? 'disabled' : ''}>上一页</button><span>第 ${page + 1} 页</span><button type="button" class="sd-btn" data-export-action="next" ${(page + 1) * 24 >= captured.rows.length ? 'disabled' : ''}>下一页</button></nav></fieldset>
          </main><footer><p role="status">${escape(notice)}</p><button type="button" class="sd-btn sd-primary" data-export-action="continue" ${busy || captured.rows.length && !selected.size ? 'disabled' : ''}>继续备份</button></footer>`;
        count();
        if (focusAction) {
            const target = dialog.querySelector(`[data-export-action="${focusAction}"]`);
            const fallback = dialog.querySelector(`[data-export-action="${focusAction === 'next' ? 'previous' : focusAction === 'previous' ? 'next' : 'cancel'}"]`);
            (target?.matches(':enabled') ? target : fallback?.matches(':enabled') ? fallback : dialog.querySelector('[data-export-action="cancel"]')).focus({ preventScroll: true });
        }
    }
    dialog.addEventListener('change', event => {
        const input = event.target.closest('[data-export-image]'); if (!input || busy) return;
        const row = captured.rows[Number(input.dataset.exportImage)]; if (!row) return;
        if (input.checked) selected.add(row.id); else selected.delete(row.id);
        count(); dialog.querySelector('[data-export-action="continue"]').disabled = captured.rows.length > 0 && !selected.size;
    });
    dialog.addEventListener('click', event => {
        const action = event.target.closest('[data-export-action]')?.dataset.exportAction;
        if (action === 'cancel') { cancel(); return; } if (busy || !action || !alive()) return;
        if (action === 'all') captured.rows.forEach(row => selected.add(row.id));
        else if (action === 'none') selected.clear();
        else if (action === 'previous') page = Math.max(0, page - 1);
        else if (action === 'next') page = Math.min(Math.max(0, Math.ceil(captured.rows.length / 24) - 1), page + 1);
        else if (action === 'continue') {
            busy = true; notice = '正在核对当前账户、聊天与所选记录…'; draw();
            let reject;
            const cancelled = new Promise((_, no) => reject = no); activeGuard = () => reject(Error('选择已取消'));
            timer = setTimeout(() => reject(Error('核对超时，未开始打包；可重试或取消')), Math.max(100, Math.min(30000, Number(timeoutMs) || 15000)));
            void (async () => {
                try {
                    await Promise.race([Promise.resolve().then(guard), cancelled]); if (!alive()) return;
                    const scope = captured.select([...selected]); scope.assertCurrent(readRecords()); finish(scope);
                } catch (error) { if (alive()) { notice = error.message; busy = false; draw(); } }
                finally { clearTimeout(timer); activeGuard = null; }
            })(); return;
        }
        draw();
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); }); dialog.addEventListener('close', cancel);
    parent.append(dialog); observer.observe(document.body, { childList: true, subtree: true }); observer.observe(parent, { attributes: true, attributeOldValue: true, attributeFilter: ['class'] });
    view.addEventListener('pagehide', cancel); draw();
    try { dialog.showModal(); } catch (_) { cancel(); }
    return finished;
}
