// Optional read-only history consumer. The directory owns source validation;
// this adapter only hands one already-read image to the active editor.
export function bindHistoricalGalleryPreviewSelection({ root, ctx, epoch,
    load, save, encode, apply, notify = () => {} } = {}) {
    if (!root || typeof ctx !== 'function'
        || typeof epoch !== 'function' || typeof load !== 'function' || typeof encode !== 'function' || typeof apply !== 'function') return;
    const sources = root.querySelector('.sd-storyboard-artist-preview-sources');
    let button = sources?.querySelector('.sd-storyboard-artist-preview-history');
    if (!button && sources) {
        button = document.createElement('button'); button.type = 'button'; button.className = 'sd-btn sd-storyboard-artist-preview-history';
        button.textContent = '角色与聊天'; sources.append(button);
    }
    if (!button) return;
    const owner = ctx()?.chatMetadata, capturedEpoch = epoch();
    const current = () => button.isConnected && root.classList.contains('open') && owner === ctx()?.chatMetadata
        && capturedEpoch === epoch();
    button.addEventListener('click', async event => {
        event.preventDefault(); if (button.disabled) return; button.disabled = true;
        try {
            const directory = await load('./qianmu-gallery-directory-view.js?v=1.59.376');
            if (current()) await directory.openGalleryDirectory({ parent: root, getContext: ctx, epoch, isCurrent: current,
                locate: () => {}, save, select: async preview => {
                    if (!current()) throw new Error('画师串编辑页面已变化，请重新打开');
                    const value = await encode(preview?.blob);
                    if (!current()) throw new Error('画师串编辑页面已变化，未套用历史图片');
                    apply(value);
                },
            }).finished;
        } catch (error) { if (current()) notify(error?.message || '角色与聊天目录暂不可用。', 'warning'); }
        finally { if (button.isConnected) button.disabled = false; }
    });
}
