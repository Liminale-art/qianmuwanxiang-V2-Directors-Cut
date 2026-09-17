import { createGalleryCatalogManagement } from './qianmu-gallery-catalog-management.js';
import { galleryDirectoryOwnerLabel } from './qianmu-gallery-directory-view.js';
import { htmlEscape as escape } from './qianmu-storyboard-utils.js';

const button = (action, label, disabled = false) => `<button type="button" class="sd-btn" data-catalog-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;
// One resource row in the existing data manager. No original media deletion,
// automatic reset/rebuild, new primary card or duplicate backup entry.
export function openGalleryCatalogManagement({ anchor, resolveNamespace, getContext = () => ({}), isCurrent = () => true,
    connect = createGalleryCatalogManagement, timeoutMs = 20000 } = {}) {
    const document = anchor.ownerDocument, view = document.defaultView, parent = anchor.closest('#story-director-modal');
    const dialog = document.createElement('dialog'); dialog.className = 'sd-bundle-dialog sd-gallery-directory'; dialog.setAttribute('aria-label', '图库目录管理');
    let closed = false, busy = true, expired = false, session, plan, page, ownerKey = '', chatKey = '', cursors = [null], confirming = false, notice = '', timer, finish;
    const finished = new Promise(resolve => finish = resolve);
    const valid = () => !closed && !session?.closed && anchor.isConnected && dialog.isConnected && parent?.classList.contains('open') && isCurrent();
    const check = () => { if (!valid()) { close(); throw Error('目录管理页面已关闭或变化'); } };
    const bytes = value => `${(value / 1024).toFixed(1)} KiB`;
    const scope = () => ({ ...(ownerKey ? { ownerKey } : {}), ...(chatKey ? { chatKey } : {}) });
    const label = () => [ownerKey ? galleryDirectoryOwnerLabel(ownerKey, getContext()) : '当前账户 · 全部目录引用', chatKey].filter(Boolean).join(' / ');
    function close() {
        if (closed) return; closed = true; clearTimeout(timer); session?.close(); observer.disconnect(); view.removeEventListener('pagehide', close);
        if (dialog.open) dialog.close(); dialog.remove(); if (anchor.isConnected) anchor.focus({ preventScroll: true }); finish();
    }
    const observer = new view.MutationObserver(records => {
        if (!valid() || records.some(row => row.target === parent && row.type === 'attributes' && !row.oldValue?.split(/\s+/).includes('open'))) close();
    });
    function draw() {
        if (!valid()) { close(); return; }
        dialog.innerHTML = `<header><b>图库目录管理</b>${button('close', '关闭')}</header><main>
          <p>只整理当前账户在本浏览器的目录引用，不删除图片、视频、聊天或提示词，不释放 VPS 原图空间。清除后需逐聊天重新收录，不会自动扫描全库重建。</p>
          <fieldset ${busy || !session ? 'disabled' : ''}><nav>${button('all', '全部')}${ownerKey ? button('owner', '此角色／群组') : ''}${button('refresh', '重新盘点')}</nav>
          <h3>${escape(label())}</h3>${ownerKey ? `<p>${escape(ownerKey)}</p>` : ''}
          <p>${plan ? `${plan.count} 条目录引用 · ${bytes(plan.bytes)} 逻辑元数据估算（非实际磁盘占用）` : '尚未完成本范围盘点，未允许清理。'}</p>
          ${confirming ? `<section role="group" aria-label="确认清除目录引用"><p>确认清除上述范围的 ${plan.count} 条目录引用？原件保留，但此操作不能直接撤回；历史目录需重新打开原聊天后收录。</p>${button('confirm', '确认清除目录引用')}${button('cancel', '返回')}</section>`
            : `${!chatKey ? `<p>${ownerKey ? '可按聊天缩小范围' : '可按角色／群组缩小范围'}</p><div class="sd-directory-rows">${(page?.rows || []).map((row, i) => `<button type="button" class="sd-directory-row" data-catalog-scope="${i}"><span><b>${escape(ownerKey ? row.chatKey : galleryDirectoryOwnerLabel(row.ownerKey, getContext()))}</b><small>${escape(row.ownerKey)}</small></span></button>`).join('') || '<p>此范围没有已收录目录。</p>'}</div><nav>${button('previous', '上一页', cursors.length === 1)}<span>第 ${cursors.length} 页</span>${button('next', '下一页', !page?.nextCursor)}</nav>` : ''}${button('clear', '清除此范围目录引用', !plan?.count)}`}
          </fieldset></main><footer><p role="status" data-catalog-status>${escape(notice || '只存来源、时间和标签的派生目录，不是原作品备份。')}</p></footer>`;
    }
    const update = message => { notice = message; if (valid()) dialog.querySelector('[data-catalog-status]').textContent = message; };
    async function loadPage() { page = chatKey ? null : await session.scopes({ ...(ownerKey ? { ownerKey } : {}), cursor: cursors.at(-1), limit: 24 }); check(); }
    async function inspect() {
        plan = null; confirming = false;
        await loadPage();
        plan = await session.inspect(scope(), value => update(`正在盘点本范围：${value.count} 条目录引用…`)); check();
        // Scope navigation and counts must refer to the same directory revision.
        if (page && page.revision !== plan.revision) { plan = null; throw Error('目录已更新，请重新盘点'); }
    }
    async function work(run) {
        if (!valid() || busy || !session) return;
        busy = true; draw();
        try { await run(); check(); }
        catch (error) { plan = null; confirming = false; notice = error?.message || '目录整理未完成，请重新盘点。'; }
        finally { busy = false; if (!closed) draw(); }
    }
    dialog.addEventListener('click', event => {
        const action = event.target.closest('[data-catalog-action]')?.dataset.catalogAction, selected = event.target.closest('[data-catalog-scope]');
        if (action === 'close') { close(); return; }
        if (!action && !selected) return;
        void work(async () => {
            if (action === 'clear') { if (plan?.count) confirming = true; return; }
            if (action === 'cancel') { confirming = false; return; }
            if (action === 'confirm') {
                if (!confirming || !plan?.count) return;
                const selectedPlan = plan; confirming = false; plan = null;
                const result = await session.clear(selectedPlan, { confirmed: true, onProgress: value => update(`已清除 ${value.removed} / ${value.total} 条目录引用；可关闭停止后续批次，已完成部分不会撤回。`) });
                cursors = [null]; await inspect(); notice = `已清除 ${result.removed} 条目录引用。图片、视频、聊天与提示词未修改。`; return;
            }
            if (action === 'next' || action === 'previous') {
                if (action === 'next' && page?.nextCursor) cursors.push(page.nextCursor);
                else if (action === 'previous' && cursors.length > 1) cursors.pop(); else return;
                await loadPage(); if (plan && page.revision !== plan.revision) throw Error('目录已更新，请重新盘点'); return;
            }
            if (selected) {
                const row = page?.rows[Number(selected.dataset.catalogScope)]; if (!row) return;
                if (ownerKey) chatKey = row.chatKey; else ownerKey = row.ownerKey;
            } else if (action === 'all') { ownerKey = ''; chatKey = ''; }
            else if (action === 'owner') chatKey = '';
            cursors = [null]; notice = ''; await inspect(); notice = '';
        });
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }); dialog.addEventListener('close', close);
    parent?.append(dialog); observer.observe(document.body, { childList: true, subtree: true });
    if (parent) observer.observe(parent, { attributes: true, attributeOldValue: true, attributeFilter: ['class'] });
    view.addEventListener('pagehide', close); draw(); if (closed) return { close, finished };
    try { dialog.showModal(); } catch (_) { close(); return { close, finished }; }
    timer = setTimeout(() => { expired = true; busy = false; notice = '目录连接超时，未清理任何引用。请关闭后重试。'; draw(); }, Math.max(100, Math.min(30000, Number(timeoutMs) || 20000)));
    void (async () => {
        try {
            const late = await connect({ resolveNamespace, isCurrent: () => valid() && !expired });
            if (!valid() || expired) { late.close(); return; } session = late; clearTimeout(timer); await inspect(); notice = '';
        } catch (error) { notice = error?.message || '目录暂不可读取'; }
        finally { busy = false; if (!closed) draw(); }
    })();
    return { close, finished };
}
