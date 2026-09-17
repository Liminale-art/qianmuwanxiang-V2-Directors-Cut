import { htmlEscape as escape } from './qianmu-storyboard-utils.js';
import { GALLERY_UNPLACED } from './qianmu-gallery-narrative.js';

const action = (name, label, disabled = false) => `<button type="button" class="sd-btn" data-gallery-narrative-action="${name}" ${disabled ? 'disabled' : ''}>${label}</button>`;
export function renderGalleryNarrative(session) {
    const view = session.view(), chosen = view.selected;
    return `<section class="sd-card sd-gallery-narrative" aria-label="当前聊天正文目录">
      <details ${view.open ? 'open' : ''}><summary>按正文查找 <span>${escape(chosen?.label || `${session.sourceCount} 层有画面`)}</span></summary>
      <div class="sd-gallery-narrative-body">
        <div class="sd-gallery-narrative-path"><span>当前聊天${view.inFloor ? ` · ${escape(chosen?.label)}` : ''}</span>${view.floorKey ? action('clear', '全部楼层') : ''}${view.paragraphKey ? action('floor', '本层全部') : ''}</div>
        <input type="search" class="text_pole" data-gallery-narrative-search value="${escape(view.query)}" maxlength="120" aria-label="搜索正文目录" placeholder="${view.inFloor ? '搜索已有画面的段落' : '搜索正文片段或楼层'}">
        <div class="sd-gallery-narrative-rows">${view.rows.map(row => `<button type="button" data-gallery-narrative-key="${escape(row.key)}" aria-pressed="${row.key === (view.paragraphKey || view.floorKey)}"><span><b>${escape(row.label)}</b><small>${escape(row.preview)}</small></span><em>${row.count}</em></button>`).join('') || '<p>没有符合条件的正文位置。</p>'}</div>
        ${view.partial ? `<p class="sd-gallery-narrative-note">${view.partial} 张仅能确认来源楼层，保留在“本层全部”，不猜测段落。</p>` : ''}
        <nav aria-label="正文目录分页">${action('previous', '上一页', !view.page)}<span>${view.page + 1} / ${view.pages}</span>${action('next', '下一页', view.page + 1 >= view.pages)}${!view.inFloor && view.unplaced ? `<button type="button" class="sd-btn" data-gallery-narrative-key="${GALLERY_UNPLACED}" aria-pressed="${view.floorKey === GALLERY_UNPLACED}">未定位画面 · ${view.unplaced}</button>` : ''}</nav>
        <p class="sd-gallery-narrative-note">当前聊天的静帧目录。无法确认来源的画面仍保留在“未定位画面”。</p>
      </div></details>
      ${chosen ? `<div class="sd-gallery-narrative-selection" role="status"><span>${escape(chosen.label)}</span>${action('clear', '清除位置筛选')}${!chosen.stale ? action('all', view.paragraphKey ? '查看本段全部静帧' : '查看当前位置全部静帧') : ''}</div>` : ''}
    </section>`;
}

// Bind only this render's nodes. No timers, global event handlers, storage, or
// closures able to act on a later chat/closed/replaced page.
export function bindGalleryNarrative(root, { session, update, isCurrent, changed }) {
    const area = root.querySelector('.sd-gallery-narrative'); if (!area) return;
    const owner = session.owner, chatKey = session.chatKey, epoch = session.epoch;
    let composing = false;
    const alive = () => area.isConnected && root.contains(area) && isCurrent()
        && session.owner === owner && session.chatKey === chatKey && session.epoch === epoch;
    function fresh() { if (!alive()) return false; update(); return alive(); }
    function finish(all) {
        if (all) session.setOpen(false);
        changed(all);
        if (isCurrent()) (root.querySelector('.sd-gallery-narrative-selection [data-gallery-narrative-action="clear"]')
            || root.querySelector('.sd-gallery-narrative summary'))?.focus({ preventScroll: true });
    }
    function paint(focus = '') {
        const next = document.createElement('template'); next.innerHTML = renderGalleryNarrative(session);
        area.replaceWith(next.content.firstElementChild);
        bindGalleryNarrative(root, { session, update, isCurrent, changed });
        if (focus) root.querySelector(`.sd-gallery-narrative ${focus}`)?.focus({ preventScroll: true });
    }
    area.querySelector('details').addEventListener('toggle', event => { if (alive()) session.setOpen(event.target.open); });
    function search(event) {
        if (composing || event.isComposing) return;
        if (!event.target.matches('[data-gallery-narrative-search]') || !fresh()) return;
        const start = event.target.selectionStart, end = event.target.selectionEnd;
        session.search(event.target.value);
        // Only directory results repaint; the media viewport and main search stay untouched.
        paint('[data-gallery-narrative-search]');
        if (start !== null) root.querySelector('[data-gallery-narrative-search]')?.setSelectionRange(start, end);
    }
    area.addEventListener('compositionstart', () => { composing = true; });
    area.addEventListener('compositionend', event => { composing = false; search(event); });
    area.addEventListener('input', search);
    area.addEventListener('click', event => {
        const button = event.target.closest('button'); if (!button || button.disabled || !fresh()) return;
        const key = button.dataset.galleryNarrativeKey, action = button.dataset.galleryNarrativeAction;
        if (key) { session.choose(key); finish(false); return; }
        if (action === 'clear') session.clear();
        else if (action === 'floor') session.allFloor();
        else if (action === 'all') { finish(true); return; }
        else if (action === 'previous' || action === 'next') { session.move(action === 'next' ? 1 : -1); paint(`[data-gallery-narrative-action="${action}"]:not(:disabled)`); return; }
        else return;
        finish(false);
    });
    for (const button of root.querySelectorAll('[data-gallery-paragraph-record]')) {
        // Rebinding after a directory-only repaint must not accumulate card listeners.
        button.onclick = () => {
            if (!fresh()) return;
            if (session.selectRecord({ id: button.dataset.galleryParagraphRecord })) finish(true);
            else finish(false);
        };
    }
}
