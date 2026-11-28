// Display-only reading sidebars. Caller owns book, companion and search state; no persistence or DOM access.
export function renderCoreadVoicePanelView(messages, htmlEscape) {
  const msgs = (messages || []).filter((m) => m.role === 'friend' && m.voiced && String(m.text || '').trim());
  if (!msgs.length) return '<div class="sd-reader-panel-empty">声音抽屉是空的</div>';
  return msgs.slice().reverse().map((m) => `
    <div class="sd-reader-voice-item" data-msg="${htmlEscape(m.id)}">
      <button class="sd-reader-voice-play" data-msg="${htmlEscape(m.id)}" title="单击播放·双击调语速/情绪"><i class="fa-solid fa-circle-play"></i></button>
      <div class="sd-reader-voice-main">
        <div class="sd-reader-voice-text">${htmlEscape(m.text || '')}</div>
        <div class="sd-reader-voice-time">${m.ts ? new Date(m.ts).toLocaleString() : ''}</div>
      </div>
    </div>`).join('');
}

export function coreadNoteMatches(note, searchValue = '', filterValue = 'all') {
  if (!note || note.kind !== 'highlight') return false;
  const search = String(searchValue || '').trim().toLowerCase();
  const filter = ['all', 'excerpt', 'note', 'favorite'].includes(filterValue) ? filterValue : 'all';
  const kind = note.annotation?.trim() ? 'note' : 'excerpt';
  const tags = Array.isArray(note.tags) ? note.tags.filter(Boolean).slice(0, 8) : [];
  return (filter === 'all' || filter === kind || (filter === 'favorite' && !!note.favorite))
    && (!search || [note.text, note.annotation, ...tags].join(' ').toLowerCase().includes(search));
}

// 章号：新笔记记在 ch，旧形状的记在 chapterIndex。
const noteChapter = (n) => Number(n?.ch ?? n?.chapterIndex) || 0;
// 「未定位」：旧划线在正文里找不到原处（from 为 null）。还没有 from 字段的旧形状照常算作有位置。
const noteUnplaced = (n) => n?.from === null;

export function renderCoreadNotesPanelView(allNotes, {noteSearch, noteFilter}, htmlEscape) {
  const notes = (allNotes || []).filter((n) => n.kind === 'highlight');
  if (!notes.length) return '<div class="sd-reader-panel-empty">还没有笔记。选中正文后可划线、记录想法或保存摘录。</div>';
  const search = String(noteSearch || '').trim().toLowerCase();
  const filter = ['all', 'excerpt', 'note', 'favorite'].includes(noteFilter) ? noteFilter : 'all';
  const ordered = notes.slice().sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || (Number(b.at) || 0) - (Number(a.at) || 0));
  let visible = 0;
  const card = (n, placed) => {
    const isNote = !!(n.annotation && n.annotation.trim());
    const tags = Array.isArray(n.tags) ? n.tags.filter(Boolean).slice(0, 8) : [];
    const created = Number(n.at) ? new Date(n.at).toLocaleDateString() : '';
    const kind = isNote ? 'note' : 'excerpt';
    const shown = coreadNoteMatches(n, search, filter);
    if (shown) visible++;
    const ch = noteChapter(n);
    return `
    <article class="sd-reader-note-item" data-note="${htmlEscape(n.id)}" data-ch="${ch}" data-kind="${kind}" data-favorite="${n.favorite ? '1' : '0'}"${shown ? '' : ' hidden'}>
      <div class="sd-reader-note-head"><span class="sd-reader-note-kind ${isNote ? 'sd-reader-kind-note' : ''}">${isNote ? '笔记' : '摘录'}</span>
        ${placed ? `<button class="sd-reader-note-jump" data-ch="${ch}" title="定位到正文">第${ch + 1}节</button>` : `<span class="sd-reader-note-where">第${ch + 1}节</span>`}
        ${created ? `<time>${htmlEscape(created)}</time>` : ''}
        <button class="sd-reader-note-tools-toggle" type="button" title="展开工具" aria-expanded="false"><i class="fa-solid fa-ellipsis"></i></button>
      </div>
      <div class="sd-reader-note-tools" hidden>
        <button class="sd-reader-note-favorite${n.favorite ? ' active' : ''}" data-note="${htmlEscape(n.id)}" title="${n.favorite ? '取消收藏' : '收藏'}"><i class="fa-${n.favorite ? 'solid' : 'regular'} fa-star"></i></button>
        <button class="sd-reader-note-copy" data-note="${htmlEscape(n.id)}" title="复制文字"><i class="fa-solid fa-copy"></i></button>
        <button class="sd-reader-note-image" data-note="${htmlEscape(n.id)}" title="生成摘录图片"><i class="fa-solid fa-image"></i></button>
        <button class="sd-reader-note-edit" data-note="${htmlEscape(n.id)}" title="${isNote ? '编辑笔记' : '加笔记'}"><i class="fa-solid fa-pen"></i></button>
        <button class="sd-reader-note-del" data-note="${htmlEscape(n.id)}" title="删除"><i class="fa-solid fa-trash"></i></button>
      </div>
      <div class="sd-reader-note-text">${htmlEscape(n.text || '')}</div>
      ${isNote ? `<div class="sd-reader-note-anno">${htmlEscape(n.annotation)}</div>` : ''}
      ${tags.length ? `<div class="sd-reader-note-tags">${tags.map((tag) => `<span>#${htmlEscape(tag)}</span>`).join('')}</div>` : ''}
    </article>`;
  };
  // 旧划线在同一章里出现过几处：第一处已是这条划线，其余每处一张卡，可定位、留下或不要。
  const pick = (n, place, index) => {
    const shown = coreadNoteMatches(n, search, filter);
    if (shown) visible++;
    const ch = noteChapter(n);
    return `
    <article class="sd-reader-note-item sd-reader-note-pick" data-note="${htmlEscape(n.id)}" data-pick="${index}" data-ch="${ch}"${shown ? '' : ' hidden'}>
      <div class="sd-reader-note-head">
        <button class="sd-reader-note-pickjump" data-note="${htmlEscape(n.id)}" data-pick="${index}" title="定位到正文">第${ch + 1}节</button>
        <button class="sd-reader-note-keep" data-note="${htmlEscape(n.id)}" data-pick="${index}" title="留下这一处"><i class="fa-solid fa-check"></i></button>
        <button class="sd-reader-note-drop" data-note="${htmlEscape(n.id)}" data-pick="${index}" title="不要这一处"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="sd-reader-note-text">${htmlEscape(n.text || '')}</div>
    </article>`;
  };
  const cards = ordered.filter((n) => !noteUnplaced(n)).map((n) => card(n, true)).join('');
  const loose = [...ordered.filter(noteUnplaced).map((n) => card(n, false)),
    ...ordered.flatMap((n) => (Array.isArray(n.candidates) ? n.candidates : []).map((place, index) => pick(n, place, index)))].join('');
  return `<div class="sd-reader-notes-toolbar">
      <label class="sd-reader-notes-search"><input type="search" placeholder="搜索摘录、笔记或标签" value="${htmlEscape(noteSearch || '')}"></label>
      <select class="sd-reader-notes-filter" title="筛选"><option value="all"${filter === 'all' ? ' selected' : ''}>全部</option><option value="excerpt"${filter === 'excerpt' ? ' selected' : ''}>仅摘录</option><option value="note"${filter === 'note' ? ' selected' : ''}>仅笔记</option><option value="favorite"${filter === 'favorite' ? ' selected' : ''}>已收藏</option></select>
    </div><div class="sd-reader-notes-list">${cards}</div>${loose ? `<div class="sd-reader-notes-group">未定位</div><div class="sd-reader-notes-list sd-reader-notes-loose">${loose}</div>` : ''}<div class="sd-reader-notes-none"${visible ? ' hidden' : ''}>没有符合条件的记录。</div>`;
}

export function renderCoreadMarksPanelView(allNotes, htmlEscape) {
  const marks = (allNotes || []).filter((n) => n.kind === 'bookmark');
  if (!marks.length) return '<div class="sd-reader-panel-empty">还没有书签。阅读时点右上角书签图标添加。</div>';
  return marks.slice().reverse().map((n) => `
    <div class="sd-reader-note-item" data-note="${htmlEscape(n.id)}">
      <div class="sd-reader-note-head">
        <button class="sd-reader-note-jump" data-ch="${noteChapter(n)}" title="跳转"><i class="fa-solid fa-bookmark"></i> 第${noteChapter(n) + 1}节</button>
        <button class="sd-reader-note-del" data-note="${htmlEscape(n.id)}" title="删除"><i class="fa-solid fa-xmark"></i></button>
      </div>
      ${n.text ? `<div class="sd-reader-note-text">${htmlEscape(n.text)}</div>` : ''}
    </div>`).join('');
}
