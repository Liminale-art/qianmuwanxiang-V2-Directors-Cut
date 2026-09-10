// Shelf cards only. Collection ownership, current metadata resolution, sorting and cover loading stay with the caller.
export function renderCoreadLibraryBookView(book, viewMode, collectionId, {htmlEscape, readerCoverPlaceholder}) {
  const prog = Math.max(0, Math.min(100, book.progress || 0));
  const bookStat = book.mode === 'comic' ? `${book.pageCount || book.chapterCount || 0}页 · 漫画` : `${book.chapterCount || 0}章 · ${(book.charCount || 0).toLocaleString()}字`;
  if (viewMode === 'list') {
    return `
      <div class="sd-reader-row" data-book="${htmlEscape(book.id)}">
        <input type="checkbox" class="sd-reader-book-check" data-book="${htmlEscape(book.id)}">
        <div class="sd-reader-row-main">
          <span class="sd-reader-row-title" title="${htmlEscape(book.title)}">${htmlEscape(book.title)}</span>
          <span class="sd-reader-row-sub">${book.author ? htmlEscape(book.author) + ' · ' : ''}${bookStat}</span>
        </div>
        <span class="sd-reader-row-prog">${prog}%</span>
        <button class="sd-reader-card-edit" data-book="${htmlEscape(book.id)}" title="编辑书籍信息"><i class="fa-solid fa-pen"></i></button>
        ${collectionId ? `<button class="sd-reader-collection-remove-book" data-book="${htmlEscape(book.id)}" title="移出当前合集"><i class="fa-solid fa-folder-minus"></i></button>` : ''}
        <button class="sd-reader-card-del" data-book="${htmlEscape(book.id)}" title="删除"><i class="fa-solid fa-trash"></i></button>
      </div>`;
  }
  const coverInner = book.hasCover
    ? `<img class="sd-reader-cover-img" data-cover="${htmlEscape(book.id)}" alt="${htmlEscape(book.title)}" loading="lazy">${readerCoverPlaceholder(book.title, book.author)}`
    : readerCoverPlaceholder(book.title, book.author);
  return `
    <div class="sd-reader-card" data-book="${htmlEscape(book.id)}">
      <div class="sd-reader-card-cover">${coverInner}
        <div class="sd-reader-prog"><span>${prog}%</span></div>
      </div>
      <div class="sd-reader-card-meta${collectionId ? ' sd-reader-card-meta-tools' : ''}">
        <div class="sd-reader-card-title" title="${htmlEscape(book.title)}">${htmlEscape(book.title)}</div>
        ${book.author ? `<div class="sd-reader-card-author" title="${htmlEscape(book.author)}">${htmlEscape(book.author)}</div>` : ''}
        <div class="sd-reader-card-sub">${bookStat}</div>
        <div class="sd-reader-card-grid-tools">
          <button class="sd-reader-card-edit" data-book="${htmlEscape(book.id)}" title="编辑书籍信息"><i class="fa-solid fa-pen"></i></button>
          ${collectionId ? `<button class="sd-reader-collection-remove-book" data-book="${htmlEscape(book.id)}" title="移出当前合集"><i class="fa-solid fa-folder-minus"></i></button>` : ''}
        </div>
      </div>
    </div>`;
}

export function renderCoreadLibraryCollectionView(collection, books, viewMode, htmlEscape) {
  const searchText = [collection.name, ...books.flatMap((book) => [book.title || '', book.author || ''])].join(' ').toLowerCase();
  if (viewMode === 'list') {
    return `
      <div class="sd-reader-collection-row" data-collection="${htmlEscape(collection.id)}" data-search="${htmlEscape(searchText)}">
        <span class="sd-reader-collection-row-icon"><i class="fa-solid fa-folder"></i></span>
        <div class="sd-reader-row-main">
          <span class="sd-reader-row-title" title="${htmlEscape(collection.name)}">${htmlEscape(collection.name)}</span>
          <span class="sd-reader-row-sub">${books.length} 本书</span>
        </div>
        <button class="sd-reader-collection-edit" data-collection="${htmlEscape(collection.id)}" title="重命名合集"><i class="fa-solid fa-pen"></i></button>
        <button class="sd-reader-collection-dissolve" data-collection="${htmlEscape(collection.id)}" title="解散合集"><i class="fa-solid fa-folder-minus"></i></button>
        <i class="fa-solid fa-chevron-right sd-reader-collection-enter"></i>
      </div>`;
  }
  const tiles = Array.from({ length: 4 }, (_, index) => {
    const book = books[index];
    if (!book) return '<span class="sd-reader-collection-tile sd-reader-collection-tile-empty"></span>';
    return `<span class="sd-reader-collection-tile">${book.hasCover ? `<img class="sd-reader-cover-img" data-cover="${htmlEscape(book.id)}" alt="" loading="lazy">` : ''}<span class="sd-reader-collection-tile-ph">${htmlEscape(book.title || '书')}</span></span>`;
  }).join('');
  return `
    <div class="sd-reader-collection-card" data-collection="${htmlEscape(collection.id)}" data-search="${htmlEscape(searchText)}">
      <div class="sd-reader-card-cover sd-reader-collection-cover">${tiles}</div>
      <div class="sd-reader-card-meta">
        <div class="sd-reader-card-title" title="${htmlEscape(collection.name)}">${htmlEscape(collection.name)}</div>
        <div class="sd-reader-card-sub">${books.length} 本书</div>
        <button class="sd-reader-collection-edit sd-reader-card-edit-grid" data-collection="${htmlEscape(collection.id)}" title="重命名合集"><i class="fa-solid fa-pen"></i></button>
      </div>
    </div>`;
}

