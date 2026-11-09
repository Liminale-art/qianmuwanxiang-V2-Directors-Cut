// Display-only paging. Full records and selection remain owned by the gallery;
// no persistence, pruning, recipe reads, or splitting of variant groups.
export const GALLERY_WINDOW_SIZE = 40;
export function galleryDisplayWindow(groups, requestedCursor = GALLERY_WINDOW_SIZE) {
  const total = groups.length, pages = Math.max(1, Math.ceil(total / GALLERY_WINDOW_SIZE));
  const cursor = Number(requestedCursor);
  const requestedPage = Number.isFinite(cursor) ? Math.max(0, Math.ceil(cursor / GALLERY_WINDOW_SIZE) - 1) : 0;
  const page = Math.min(pages - 1, requestedPage), start = page * GALLERY_WINDOW_SIZE;
  return {items:groups.slice(start,start+GALLERY_WINDOW_SIZE),total,start,end:Math.min(total,start+GALLERY_WINDOW_SIZE),
    page:page+1,pages,cursor:(page+1)*GALLERY_WINDOW_SIZE,
    previous:page ? page*GALLERY_WINDOW_SIZE : null,next:page+1<pages ? (page+2)*GALLERY_WINDOW_SIZE : null};
}

export function renderGalleryWindowControls(window, position = 'top') {
  if (window.pages <= 1) return '';
  const unit=window.unit==='项'?'项':'组';
  const button = (cursor, direction, icon) => `<button type="button" class="sd-icon-btn" data-gallery-window="${cursor??''}" data-gallery-window-current="${window.cursor}" title="${direction}" aria-label="${direction}" ${cursor===null?'disabled':''}><i class="fa-solid fa-chevron-${icon}"></i></button>`;
  return `<nav class="sd-gallery-window-controls" data-gallery-window-position="${position==='bottom'?'bottom':'top'}" aria-label="阅片条目分页" tabindex="-1">${button(window.previous,'上一页画面','left')}<span aria-live="polite">${window.start+1}–${window.end} / ${window.total} ${unit} · ${window.page}/${window.pages}</span>${button(window.next,'下一页画面','right')}</nav>`;
}

export function galleryCardBindings(cards, readRecords, groupId) {
  const visible = Array.from(cards);
  if (!visible.length) return [];
  const wantedIds = new Set(visible.map(card=>card.dataset.storyboardRecord));
  const variants = new Map(visible.map(card=>[card.dataset.storyboardGroup,[]])), records = new Map();
  for (const record of readRecords()) {
    if (wantedIds.has(record.id) && !records.has(record.id)) records.set(record.id,record);
    const target = variants.get(groupId(record));
    if (target) target.push(record);
  }
  for (const rows of variants.values()) rows.sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
  return visible.map(card=>({card,record:records.get(card.dataset.storyboardRecord),variants:[...(variants.get(card.dataset.storyboardGroup)||[])]}));
}

const bindings = new WeakMap();
export function bindGalleryWindowControls(root, {scope,readCursor,change,scroller}) {
  let captured;
  try { captured = [...scope()]; } catch { return; }
  const current = () => {
    if (root.isConnected === false) return false;
    try {
      const now = scope();
      return captured.length===now.length && captured.every((value,index)=>value===now[index]);
    } catch { return false; }
  };
  for (const button of root.querySelectorAll('[data-gallery-window]')) {
    const previous = bindings.get(button);
    if (previous) button.removeEventListener('click',previous);
    const click = event => {
      event.preventDefault();
      const expected = Number(button.dataset.galleryWindowCurrent), target = Number(button.dataset.galleryWindow);
      if (button.disabled || button.isConnected === false || !current() || expected!==readCursor() || !Number.isSafeInteger(target)
        || target<GALLERY_WINDOW_SIZE || target%GALLERY_WINDOW_SIZE || Math.abs(target-expected)!==GALLERY_WINDOW_SIZE) return;
      change(target);
      if (!current()) return;
      const nav = root.querySelector('[data-gallery-window-position="top"]'), body = scroller();
      if (nav && body) body.scrollTop += nav.getBoundingClientRect().top-body.getBoundingClientRect().top;
      nav?.focus({preventScroll:true});
    };
    button.addEventListener('click',click);bindings.set(button,click);
  }
}
