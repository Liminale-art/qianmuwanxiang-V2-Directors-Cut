// Read-only image zoom/pan. No source lookup, download, media loading or persistence.
export function bindGalleryPreviewZoom(root, { width, height, isCurrent = () => true }) {
    const stage = root.querySelector('.sd-directory-image-stage'), space = stage?.firstElementChild, image = space?.querySelector('img');
    if (!stage || !image) return () => {};
    const controller = new AbortController(), options = { signal: controller.signal }, pointers = new Map();
    let scale = 1, closed = false;
    function zoom(next, anchor = null) {
        if (closed || !isCurrent()) return;
        const rect = stage.getBoundingClientRect(), before = image.getBoundingClientRect();
        const point = anchor || { x: rect.left + stage.clientWidth / 2, y: rect.top + stage.clientHeight / 2 };
        const rx = before.width ? (point.x - before.left) / before.width : .5, ry = before.height ? (point.y - before.top) / before.height : .5;
        const fit = Math.min(stage.clientWidth / width, stage.clientHeight / height, 1);
        scale = Math.max(1, Math.min(16, next));
        const w = width * fit * scale, h = height * fit * scale, sw = Math.max(stage.clientWidth, w), sh = Math.max(stage.clientHeight, h);
        space.style.width = `${sw}px`; space.style.height = `${sh}px`; image.style.width = `${w}px`; image.style.height = `${h}px`;
        stage.scrollLeft = (sw - w) / 2 + rx * w - (point.x - rect.left);
        stage.scrollTop = (sh - h) / 2 + ry * h - (point.y - rect.top);
        stage.dataset.scale = String(scale); root.querySelector('[data-preview-scale]').textContent = `${Math.round(scale * 100)}%`;
    }
    for (const button of root.querySelectorAll('[data-preview-zoom]')) button.addEventListener('click', event => {
        event.stopPropagation(); const action = button.dataset.previewZoom; zoom(action === 'reset' ? 1 : scale * (action === 'in' ? 1.25 : .8));
    }, options);
    stage.addEventListener('wheel', event => { event.preventDefault(); zoom(scale * Math.exp(-event.deltaY * .002), { x: event.clientX, y: event.clientY }); }, { ...options, passive: false });
    stage.addEventListener('keydown', event => { if (['+', '=', '-', '0'].includes(event.key)) { event.preventDefault(); zoom(event.key === '0' ? 1 : scale * (event.key === '-' ? .8 : 1.25)); } }, options);
    stage.addEventListener('dblclick', () => zoom(1), options);
    const pair = () => { const [a, b] = [...pointers.values()]; return a && b ? { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null; };
    stage.addEventListener('pointerdown', event => {
        if (closed || !isCurrent()) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.preventDefault(); stage.focus({ preventScroll: true }); pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        try { stage.setPointerCapture(event.pointerId); } catch (_) { /* Synthetic or already-released pointer. */ }
    }, options);
    stage.addEventListener('pointermove', event => {
        if (closed || !isCurrent()) return;
        const previous = pointers.get(event.pointerId); if (!previous) return;
        const before = pair(); pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); const after = pair();
        if (before?.distance > 0 && after) zoom(scale * after.distance / before.distance, after);
        else { stage.scrollLeft -= event.clientX - previous.x; stage.scrollTop -= event.clientY - previous.y; }
    }, options);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(type, event => { pointers.delete(event.pointerId); }, options);
    const resize = new ResizeObserver(() => zoom(scale)); resize.observe(stage); zoom(1);
    return () => { closed = true; controller.abort(); resize.disconnect(); pointers.clear(); };
}
