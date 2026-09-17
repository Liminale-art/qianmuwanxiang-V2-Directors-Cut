import { htmlEscape as escape } from './qianmu-storyboard-utils.js';
import { createGalleryDirectorySession } from './qianmu-gallery-directory.js';
import { bindGalleryPreviewZoom } from './qianmu-gallery-preview-zoom.js';

const button = (action, label, disabled = false) => `<button type="button" class="sd-btn" data-directory-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;
export function galleryDirectoryOwnerLabel(ownerKey, context) {
    const group = ownerKey.startsWith('group:'), key = ownerKey.slice(group ? 6 : 5);
    const candidates = group ? context?.groups : context?.characters;
    const rows = Array.isArray(candidates) ? candidates : [];
    const found = rows.filter(row => row && (group ? String(row.id) === key : row.avatar === key));
    return found.length === 1 && typeof found[0].name === 'string' && found[0].name.trim()
        ? found[0].name : `${group ? '群组' : '角色文件'} · ${key}`;
}

// The directory is a local, rebuildable list of observed references, not an
// account-wide server inventory. Only an explicit picture click loads media.
export function openGalleryDirectory({ parent, getContext, epoch, isCurrent = () => true, locate, save,
    connect = createGalleryDirectorySession, timeoutMs = 20000 } = {}) {
    const document = parent.ownerDocument, view = document.defaultView, returnFocus = document.activeElement;
    const dialog = document.createElement('dialog'); dialog.className = 'sd-bundle-dialog sd-gallery-directory';
    dialog.setAttribute('aria-label', '角色与聊天目录');
    let closed = false, busy = true, session, page = null, stack = [null], ownerKey = '', chatKey = '', tag = '', notice = '', sourceNotice = '';
    let timer, resolve, openingExpired = false; const finished = new Promise(done => resolve = done);
    let preview = null, previewUrl = '', releaseZoom, listScroll = 0, restoreList = false, previewIndex = 0;
    function releasePreview() { releaseZoom?.(); releaseZoom = null; if (preview) session?.releasePreview?.(preview); if (previewUrl) view.URL.revokeObjectURL(previewUrl); previewUrl = ''; preview = null; }
    function close() {
        if (closed) return; closed = true; clearTimeout(timer); observer.disconnect(); view.removeEventListener('pagehide', close);
        releasePreview();
        session?.close(); if (dialog.open) dialog.close(); dialog.remove();
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); resolve();
    }
    function alive() {
        if (closed) return false;
        try {
            if (!dialog.isConnected || !parent.isConnected || !parent.classList.contains('open') || !isCurrent()) throw Error();
            session?.assertCurrent(); return true;
        } catch (_) { close(); return false; }
    }
    const guard = () => { if (!alive() || openingExpired) throw Error('目录来源页面已变化或连接超时'); };
    const observer = new view.MutationObserver(records => {
        if (!alive() || records.some(row => row.type === 'attributes' && row.target === parent && !row.oldValue?.split(/\s+/).includes('open'))) close();
    });
    function draw() {
        if (!alive()) return;
        releaseZoom?.(); releaseZoom = null;
        if (preview) {
            dialog.innerHTML = `<header><b>历史画面 · 只读</b>${button('preview-back', '返回目录', busy)}${button('close', '关闭')}</header><main>
              <div class="sd-directory-image-stage" tabindex="0" aria-label="历史原图；滚轮或双指缩放，拖动平移，0 恢复"><div><img src="${escape(previewUrl)}" alt="${escape(preview.record.tags.join(' · ') || '历史画面')}" draggable="false"></div></div>
              <nav aria-label="图片操作"><button type="button" class="sd-btn" data-preview-zoom="out" aria-label="缩小">−</button><span data-preview-scale>100%</span><button type="button" class="sd-btn" data-preview-zoom="in" aria-label="放大">＋</button><button type="button" class="sd-btn" data-preview-zoom="reset">恢复适配</button>${typeof save === 'function' ? button('preview-save', '保存原图', busy) : ''}</nav>
              <details class="sd-directory-image-details"><summary>来源与详情</summary><p>${escape(galleryDirectoryOwnerLabel(preview.source.ownerKey, getContext()))}</p><p>${escape(preview.source.chatKey)}</p><p>${escape(preview.source.ownerKey)}</p><p>${escape(new Date(preview.record.createdAt).toLocaleString())} · ${preview.width} × ${preview.height}</p><p>${escape(preview.record.tags.join(' · '))}</p><p>按原文件位置读取的当前快照，不是永久归属或原件一致性证明。</p></details>
              </main><footer><p role="status">只读查看，可保存本次读取的图片文件，保留其自带元数据；不另附千幕资料，不是完整联包备份。</p></footer>`;
            releaseZoom = bindGalleryPreviewZoom(dialog, { ...preview, isCurrent: alive }); return;
        }
        const focused = document.activeElement;
        const focusKey = ['data-directory-action', 'data-directory-scope', 'data-directory-record'].find(key => dialog.contains(focused) && focused.hasAttribute(key));
        const focusValue = focusKey ? focused.getAttribute(focusKey) : '';
        const own = session && ownerKey === session.source.ownerKey && chatKey === session.source.chatKey;
        const title = chatKey || (ownerKey ? galleryDirectoryOwnerLabel(ownerKey, getContext()) : '选择角色或群组');
        dialog.innerHTML = `<header><b>角色与聊天</b>${button('close', '关闭')}</header><main>
          <p class="sd-directory-boundary">本机目录 · 只收录访问并核对过的聊天，不代表账户全部资料。历史引用不随原件缺失自动删除。</p>
          <fieldset ${busy ? 'disabled' : ''}><nav>${button('owners', '全部角色')}${ownerKey ? button('chats', '该角色的聊天', !chatKey) : ''}${button('refresh', '更新当前聊天目录', !session)}</nav>
          <h3>${escape(title)}</h3>${ownerKey ? `<p>${escape(ownerKey)}</p>` : ''}
          ${chatKey ? `<form class="sd-directory-search"><input class="text_pole" type="search" name="tag" maxlength="80" value="${escape(tag)}" placeholder="按完整标签查找" aria-label="目录标签"><button type="submit" class="sd-btn">查找</button>${button('clear-tag', '清除', !tag)}</form><p>${own ? '当前聊天 · 可打开原画面' : '历史目录 · 可只读预览 ST 内保存的原图，不切换当前聊天。'}</p>` : ''}
          <div class="sd-directory-rows">${(page?.rows || []).map((row, i) => chatKey
            ? `<div class="sd-directory-row"><span><b>${escape(row.tags.slice(0, 3).join(' · ') || '静帧')}</b><small>${escape(new Date(row.createdAt).toLocaleString())}</small></span><button type="button" class="sd-btn" ${own ? 'data-directory-record' : 'data-directory-history'}="${i}">${own ? '查看画面' : '只读预览'}</button></div>`
            : `<button type="button" class="sd-directory-row" data-directory-scope="${i}"><span><b>${escape(ownerKey ? row.chatKey : galleryDirectoryOwnerLabel(row.ownerKey, getContext()))}</b><small>${escape(ownerKey ? '查看该聊天目录' : row.ownerKey)}</small></span></button>`).join('') || `<p>${busy ? '正在读取目录…' : '没有符合条件的目录条目；未收录不等于没有原作品。'}</p>`}</div>
          <nav aria-label="图库目录分页">${button('previous', '上一页', stack.length === 1)}<span>第 ${stack.length} 页</span>${button('next', '下一页', !page?.nextCursor)}</nav></fieldset>
          ${sourceNotice ? `<p class="sd-directory-source" role="status">${escape(sourceNotice)}</p>` : ''}
          </main><footer><p role="status">${escape(notice || '目录只存来源、时间和标签；不复制提示词、图片或聊天正文。')}</p></footer>`;
        if (focusKey) {
            const target = [...dialog.querySelectorAll(`[${focusKey}]`)].find(node => node.getAttribute(focusKey) === focusValue && !node.matches(':disabled'));
            (target || dialog.querySelector('[data-directory-action="close"]'))?.focus({ preventScroll: true });
        }
        if (restoreList) { restoreList = false; dialog.querySelector('main').scrollTop = listScroll; dialog.querySelector(`[data-directory-history="${previewIndex}"]`)?.focus({ preventScroll: true }); }
    }
    async function load() {
        const input = { ...(ownerKey ? { ownerKey } : {}), cursor: stack.at(-1), limit: 24 };
        const result = chatKey ? await session.page({ ...input, chatKey, tags: tag ? [tag] : [] }) : await session.scopes(input);
        guard(); page = result;
    }
    async function work(action) {
        if (!alive() || busy || !session) return;
        busy = true; notice = ''; draw();
        try { await action(); guard(); }
        catch (error) { if (alive()) notice = `${error?.message || '目录读取未完成'}。原聊天和原图未修改。`; }
        finally { busy = false; draw(); }
    }
    async function saveOriginal() {
        if (!alive() || busy || !preview || typeof save !== 'function') return;
        busy = true;
        const buttons = () => dialog.querySelectorAll('[data-directory-action="preview-save"],[data-directory-action="preview-back"]');
        const status = message => { if (alive()) dialog.querySelector('footer [role="status"]').textContent = message; };
        for (const node of buttons()) node.disabled = true;
        status('正在核对原聊天来源，保存本次读取的原图…');
        try {
            await session.savePreview(preview, (blob, filename) => { guard(); return save(blob, filename); });
            guard(); status('原图已交给浏览器保存，请确认下载结果。原图自带元数据保留，不另附千幕资料，不是完整联包备份。');
        } catch (error) { if (alive()) status(`${error?.message || '原图保存未完成'}。未修改或删除原资料。`); }
        finally { busy = false; if (alive()) for (const node of buttons()) node.disabled = false; }
        // Keep the existing image node, zoom, scroll and expanded details intact.
    }
    function reset() { stack = [null]; page = null; sourceNotice = ''; tag = ''; }
    async function refresh() {
        notice = '正在核对服务器已保存的当前静帧，再更新本机目录…'; draw();
        try {
            const result = await session.refresh(); guard();
            notice = `当前聊天 ${result.indexed} 条静帧已收录${result.skipped ? `；${result.skipped} 条元数据不完整，原处保留` : ''}。其他聊天需打开后收录，旧引用保留。`;
        } catch (error) { guard(); notice = `${error.message}。仍可浏览先前目录，未覆盖原资料。`; }
        ownerKey = ''; chatKey = ''; reset(); await load();
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }); dialog.addEventListener('close', close);
    dialog.addEventListener('click', event => {
        const action = event.target.closest('[data-directory-action]')?.dataset.directoryAction;
        if (action === 'close') { close(); return; }
        if (action === 'preview-save') { void saveOriginal(); return; }
        const selected = event.target.closest('[data-directory-scope]'), record = event.target.closest('[data-directory-record]');
        const historical = event.target.closest('[data-directory-history]');
        if (!action && !selected && !record && !historical) return;
        if (historical) listScroll = dialog.querySelector('main').scrollTop;
        void work(async () => {
            if (action === 'preview-back') { releasePreview(); restoreList = true; }
            else if (historical) {
                previewIndex = Number(historical.dataset.directoryHistory); const row = page?.rows[previewIndex]; if (!row) return;
                notice = '正在从原聊天读取这一张画面…'; draw();
                const result = await session.preview(row); guard();
                previewUrl = view.URL.createObjectURL(result.blob); preview = result;
            } else if (selected) {
                const row = page?.rows[Number(selected.dataset.directoryScope)]; if (!row) return;
                if (ownerKey) chatKey = row.chatKey; else ownerKey = row.ownerKey;
                reset(); await load(); draw();
                if (chatKey) {
                    sourceNotice = '正在核对原聊天文件…'; draw();
                    try {
                        const receipt = await session.inspectSource({ ownerKey, chatKey }); guard();
                        sourceNotice = receipt.state === 'present' ? `原聊天文件可读，保存有 ${receipt.gallery.count} 条静帧。历史目录条目未逐条重核，不代表原图仍可访问。` : '原聊天目前没有静帧记录；旧目录引用保留。';
                        if (ownerKey.startsWith('group:')) sourceNotice += ' 群聊文件可读不代表群组归属已重新确认。';
                    } catch (error) { guard(); sourceNotice = `来源未确认：${error.message}。目录引用保留。`; }
                }
            } else if (record) {
                const row = page?.rows[Number(record.dataset.directoryRecord)]; if (!row) return;
                const original = await session.locate(row); guard(); close(); await locate(original);
            } else if (action === 'refresh') await refresh();
            else if (action === 'owners' || action === 'chats') { if (action === 'owners') ownerKey = ''; chatKey = ''; reset(); await load(); }
            else if (action === 'clear-tag') { tag = ''; stack = [null]; page = null; await load(); }
            else if (action === 'previous' || action === 'next') {
                if (action === 'previous' && stack.length > 1) stack.pop();
                else if (action === 'next' && page?.nextCursor) stack.push(page.nextCursor); else return;
                page = null; await load();
            }
        });
    });
    dialog.addEventListener('submit', event => {
        event.preventDefault(); if (!event.target.matches('.sd-directory-search')) return;
        const value = new FormData(event.target).get('tag');
        void work(async () => { tag = value.trim(); stack = [null]; page = null; await load(); });
    });
    parent.append(dialog); observer.observe(parent, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class'] });
    observer.observe(document.body, { childList: true, subtree: true }); view.addEventListener('pagehide', close); draw();
    try { dialog.showModal(); } catch (error) { close(); throw error; }
    timer = setTimeout(() => { openingExpired = true; busy = false; notice = '连接超时，未更新目录。请关闭后重试。'; draw(); }, Math.max(100, Math.min(30000, Number(timeoutMs) || 20000)));
    void (async () => {
        try {
            const connected = await connect({ getContext, epoch, guard });
            if (!alive() || openingExpired) { connected.close(); return; }
            session = connected; clearTimeout(timer); await refresh();
        } catch (error) { if (alive()) notice = `${error.message}。请关闭后重试；需要已打开的聊天与已确认的 ST 账户。`; }
        finally { busy = false; draw(); }
    })();
    return { close, finished };
}
